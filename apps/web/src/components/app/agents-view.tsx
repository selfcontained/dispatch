import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PanelLeftOpen, PanelRightOpen } from "lucide-react";
import { useAtom } from "jotai";

import { AgentListContent } from "@/components/app/agent-sidebar";
import { CreateAgentDialog } from "@/components/app/create-agent-dialog";
import { DeleteAgentDialog } from "@/components/app/delete-agent-dialog";
import {
  type FeedbackDetailState,
  FeedbackDetailPanel,
  MobileFeedbackSheet,
  MobileReviewSummarySheet,
  ReviewSummaryPanel,
} from "@/components/app/feedback-panel";
import { MediaLightbox } from "@/components/app/media-lightbox";
import {
  MediaSidebar,
  MediaSidebarContent,
  MEDIA_SIDEBAR_SETTLE_FALLBACK_MS,
} from "@/components/app/media-sidebar";
import { TerminalCopyModeBannerLayer } from "@/components/app/terminal-copy-mode-banner";
import { MobileTerminalToolbar } from "@/components/app/mobile-terminal-toolbar";
import { SidebarShell, type NavSection } from "@/components/app/sidebar-shell";
import { StopAgentDialog } from "@/components/app/stop-agent-dialog";
import { TerminalPane } from "@/components/app/terminal-pane";
import {
  type Agent,
  type AgentVisualState,
  type ConnState,
} from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { GlassSidebar } from "@/components/ui/glass-sidebar";
import { api } from "@/lib/api";
import { type AgentType, isAgentType } from "@/lib/agent-types";
import { type IdeType } from "@/lib/ide-types";
import {
  agentFeedbackRoute,
  agentReviewRoute,
  agentRoute,
} from "@/lib/agent-routes";
import { cn } from "@/lib/utils";
import { useAgents } from "@/hooks/use-agents";
import { useMedia } from "@/hooks/use-media";
import { useTerminal } from "@/hooks/use-terminal";
import { useAgentFocus } from "@/hooks/use-agent-focus";
import {
  inactiveMediaSidebarStateAtom,
  mediaSidebarStateAtomFamily,
  reconcileMediaSidebarStateStorage,
  type MediaSidebarTab,
} from "@/lib/store";

const CODEX_FULL_ACCESS_ARG = "--dangerously-bypass-approvals-and-sandbox";
const CLAUDE_FULL_ACCESS_ARG = "--dangerously-skip-permissions";
const LAST_USED_TYPE_KEY = "dispatch:lastUsedAgentType";
const EXPANDED_AGENT_ID_KEY = "dispatch:expandedAgentId";
function agentProjectRoot(agent: Agent | undefined | null): string | undefined {
  return agent?.gitContext?.repoRoot?.trim() || agent?.cwd?.trim() || undefined;
}

function readLastUsedAgentType(): AgentType | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(LAST_USED_TYPE_KEY)?.trim();
  return stored && isAgentType(stored) ? stored : null;
}

function readExpandedAgentId(): string | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(EXPANDED_AGENT_ID_KEY)?.trim();
  return stored && stored.length > 0 ? stored : null;
}

function isFullAccessEnabled(
  agent: Pick<Agent, "fullAccess" | "agentArgs">
): boolean {
  return (
    agent.fullAccess ||
    agent.agentArgs.includes(CODEX_FULL_ACCESS_ARG) ||
    agent.agentArgs.includes(CLAUDE_FULL_ACCESS_ARG)
  );
}

type AgentsViewProps = {
  enabledAgentTypes: AgentType[];
  enabledIdes: IdeType[];
  isMobile: boolean;
  leftOpen: boolean;
  leftPanelOpen: boolean;
  mobileLeftOpen: boolean;
  mobileMediaOpen: boolean;
  setLeftOpen: (open: boolean) => void;
  setMobileLeftOpen: (open: boolean) => void;
  setMobileMediaOpen: (open: boolean) => void;
  handleSetLeftPanelOpen: (open: boolean) => void;
  pulsingNavItem: string | null;
  triggerNavAnimation: (navItem: string) => void;
  onNavigateSection: (section: NavSection) => void;
};

export function AgentsView({
  enabledAgentTypes,
  enabledIdes,
  isMobile,
  leftOpen,
  leftPanelOpen,
  mobileLeftOpen,
  mobileMediaOpen,
  setLeftOpen,
  setMobileLeftOpen,
  setMobileMediaOpen,
  handleSetLeftPanelOpen,
  pulsingNavItem,
  triggerNavAnimation,
  onNavigateSection,
}: AgentsViewProps): JSX.Element {
  const navigate = useNavigate();
  const { agentId: routeAgentId, itemId, summaryAgentId } = useParams();

  const [sharedConnectedAgentId, setSharedConnectedAgentId] = useState<
    string | null
  >(null);
  const [sharedConnState, setSharedConnState] =
    useState<ConnState>("disconnected");

  const {
    agents,
    agentsLoaded,
    validatedSelectedAgentId,
    selectedAgent,
    connectedAgent,
    overflowAgentId,
    setOverflowAgentId,
    agentVisualState,
    resortAgents,
  } = useAgents(
    sharedConnectedAgentId,
    sharedConnState,
    true,
    routeAgentId ?? null
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [requestedCreateType, setRequestedCreateType] =
    useState<AgentType | null>(null);
  const [lastUsedAgentType, setLastUsedAgentType] = useState<AgentType | null>(
    () => readLastUsedAgentType()
  );
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Agent | null>(null);
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [stopTarget, setStopTarget] = useState<Agent | null>(null);
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(() =>
    readExpandedAgentId()
  );

  const feedbackItemId =
    itemId !== undefined && Number.isInteger(Number(itemId))
      ? Number(itemId)
      : null;
  const feedbackDetail = routeAgentId
    ? summaryAgentId
      ? { parentAgentId: routeAgentId, summaryAgentId }
      : feedbackItemId !== null
        ? { parentAgentId: routeAgentId, itemId: feedbackItemId }
        : null
    : null;
  const feedbackDetailStaleRef =
    useRef<NonNullable<FeedbackDetailState> | null>(null);
  if (feedbackDetail) feedbackDetailStaleRef.current = feedbackDetail;
  const feedbackDetailRendered =
    feedbackDetail ?? feedbackDetailStaleRef.current;
  const pendingAutoAttachAgentIdRef = useRef<string | null>(null);
  const sidebarAgentId = sharedConnectedAgentId ?? validatedSelectedAgentId;
  const desktopMediaSidebarAtom = useMemo(
    () =>
      sidebarAgentId
        ? mediaSidebarStateAtomFamily(sidebarAgentId)
        : inactiveMediaSidebarStateAtom,
    [sidebarAgentId]
  );
  const [desktopMediaSidebarState, setDesktopMediaSidebarState] = useAtom(
    desktopMediaSidebarAtom
  );
  const [deferMediaResize, setDeferMediaResize] = useState(false);
  const [mediaResizeSettleKey, setMediaResizeSettleKey] = useState(0);
  const mediaOpen = isMobile
    ? mobileMediaOpen
    : desktopMediaSidebarState.isOpen;
  const mediaPanelOpen = mediaOpen;
  const mediaActiveTab = desktopMediaSidebarState.activeTab;
  const mediaPinned = desktopMediaSidebarState.isPinned ?? false;
  // Layout only shifts (and the terminal needs a refit) when the sidebar is
  // open AND pinned. Drawer (unpinned) mode floats over the terminal.
  const mediaShiftsLayout = !isMobile && mediaOpen && mediaPinned;
  const mediaResizeTimerRef = useRef<number | null>(null);

  const setMediaActiveTab = useCallback(
    (activeTab: MediaSidebarTab) => {
      setDesktopMediaSidebarState((prev) => ({ ...prev, activeTab }));
    },
    [setDesktopMediaSidebarState]
  );

  const setMediaOpen = useCallback(
    (open: boolean) => {
      if (isMobile) {
        if (open) setMobileLeftOpen(false);
        setMobileMediaOpen(open);
        return;
      }

      setDesktopMediaSidebarState((prev) =>
        prev.isOpen === open ? prev : { ...prev, isOpen: open }
      );
    },
    [
      isMobile,
      setDesktopMediaSidebarState,
      setMobileLeftOpen,
      setMobileMediaOpen,
    ]
  );

  const toggleMediaPinned = useCallback(() => {
    setDesktopMediaSidebarState((prev) => ({
      ...prev,
      isPinned: !(prev.isPinned ?? false),
    }));
  }, [setDesktopMediaSidebarState]);

  const finishMediaResizeSettle = useCallback(() => {
    if (mediaResizeTimerRef.current) {
      window.clearTimeout(mediaResizeTimerRef.current);
      mediaResizeTimerRef.current = null;
    }
    setDeferMediaResize(false);
    setMediaResizeSettleKey((current) => current + 1);
  }, []);

  const prevMediaShiftsLayoutRef = useRef(mediaShiftsLayout);
  useEffect(() => {
    if (!agentsLoaded) return;
    reconcileMediaSidebarStateStorage(agents.map((agent) => agent.id));
  }, [agents, agentsLoaded]);

  useEffect(() => {
    if (isMobile) {
      prevMediaShiftsLayoutRef.current = mediaShiftsLayout;
      return;
    }
    if (prevMediaShiftsLayoutRef.current === mediaShiftsLayout) return;
    prevMediaShiftsLayoutRef.current = mediaShiftsLayout;
    setDeferMediaResize(true);
    if (mediaResizeTimerRef.current) {
      window.clearTimeout(mediaResizeTimerRef.current);
    }
    mediaResizeTimerRef.current = window.setTimeout(
      finishMediaResizeSettle,
      MEDIA_SIDEBAR_SETTLE_FALLBACK_MS
    );
  }, [finishMediaResizeSettle, isMobile, mediaShiftsLayout]);

  useEffect(
    () => () => {
      if (mediaResizeTimerRef.current) {
        window.clearTimeout(mediaResizeTimerRef.current);
      }
    },
    []
  );

  const {
    connState,
    connectedAgentId,
    terminalMode,
    terminalPlaceholderMessage,
    copyMode,
    statusMessage,
    terminalHostRef,
    ctrlPendingRef,
    focusTerminal,
    ensureTerminalConnected,
    detachTerminal,
    sendTerminalInput,
    exitCopyMode,
    resyncing,
  } = useTerminal({
    authState: "authenticated",
    agents,
    selectedAgentId: validatedSelectedAgentId,
    theme: "dark" as never,
    isMobile,
    leftOpen,
    deferMediaResize,
    mediaResizeSettleKey,
    feedbackOpen: !!feedbackDetail,
  });

  useEffect(() => {
    setSharedConnectedAgentId(connectedAgentId);
  }, [connectedAgentId]);

  useEffect(() => {
    setSharedConnState(connState);
  }, [connState]);

  useEffect(() => {
    resortAgents();
  }, [connectedAgentId, resortAgents]);

  const focusedAgentId = resyncing
    ? validatedSelectedAgentId
    : connState === "connected" || connState === "reconnecting"
      ? (connectedAgentId ?? validatedSelectedAgentId)
      : null;
  const focusedAgent = focusedAgentId
    ? (agents.find((agent) => agent.id === focusedAgentId) ?? null)
    : null;

  const {
    mediaFiles,
    animatingMediaKeys,
    unseenMediaCount,
    lightboxIndex,
    lightboxItem,
    setLightboxIndex,
    openLightbox,
    mediaViewportRef,
    refreshMedia,
  } = useMedia(focusedAgentId, mediaPanelOpen);

  const focusedAgentHasStream = focusedAgent?.hasStream ?? false;
  const focusedAgentStreamUrl = focusedAgentId
    ? `/api/v1/agents/${focusedAgentId}/stream`
    : null;
  const prevFocusedAgentHasStreamRef = useRef(focusedAgentHasStream);

  useEffect(() => {
    const streamStarted =
      !prevFocusedAgentHasStreamRef.current && focusedAgentHasStream;
    prevFocusedAgentHasStreamRef.current = focusedAgentHasStream;
    if (!streamStarted) return;
    setMediaOpen(true);
  }, [focusedAgentHasStream, setMediaOpen]);

  useAgentFocus(focusedAgentId, "authenticated");

  const prevLeftOpenRef = useRef(leftPanelOpen);
  const prevMediaOpenRef = useRef(mediaPanelOpen);
  useEffect(() => {
    const leftClosed = prevLeftOpenRef.current && !leftPanelOpen;
    const mediaClosed = prevMediaOpenRef.current && !mediaPanelOpen;
    prevLeftOpenRef.current = leftPanelOpen;
    prevMediaOpenRef.current = mediaPanelOpen;
    if (leftClosed || mediaClosed) {
      const timer = window.setTimeout(focusTerminal, 50);
      return () => window.clearTimeout(timer);
    }
  }, [leftPanelOpen, mediaPanelOpen, focusTerminal]);

  const uploadFile = useCallback(async (agentId: string, file: File) => {
    const form = new FormData();
    form.append("source", "user");
    form.append("file", file, file.name);
    const res = await fetch(`/api/v1/agents/${agentId}/media`, {
      method: "POST",
      credentials: "include",
      body: form,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(body?.error ?? `Upload failed (${res.status})`);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!expandedAgentId) {
      window.localStorage.removeItem(EXPANDED_AGENT_ID_KEY);
      return;
    }
    window.localStorage.setItem(EXPANDED_AGENT_ID_KEY, expandedAgentId);
  }, [expandedAgentId]);

  useEffect(() => {
    pendingAutoAttachAgentIdRef.current = routeAgentId ?? null;
  }, [routeAgentId]);

  const selectedExpansionTarget = useMemo(() => {
    if (!validatedSelectedAgentId) return null;
    const selected = agents.find((a) => a.id === validatedSelectedAgentId);
    return selected?.parentAgentId ?? validatedSelectedAgentId;
  }, [agents, validatedSelectedAgentId]);
  const prevSelectedExpansionTargetRef = useRef<string | null>(null);

  useEffect(() => {
    if (!routeAgentId) return;
    if (!agentsLoaded) return;
    if (validatedSelectedAgentId) return;
    navigate("/agents", { replace: true });
  }, [agentsLoaded, navigate, routeAgentId, validatedSelectedAgentId]);

  useEffect(() => {
    if (!selectedExpansionTarget) {
      prevSelectedExpansionTargetRef.current = null;
      return;
    }
    if (prevSelectedExpansionTargetRef.current === selectedExpansionTarget) {
      return;
    }
    prevSelectedExpansionTargetRef.current = selectedExpansionTarget;
    setExpandedAgentId((current) =>
      current === selectedExpansionTarget ? current : selectedExpansionTarget
    );
  }, [selectedExpansionTarget]);

  useEffect(() => {
    if (!routeAgentId) return;
    if (!agentsLoaded) return;
    if (itemId !== undefined && feedbackItemId === null) {
      navigate(agentRoute(routeAgentId), { replace: true });
    }
  }, [agentsLoaded, feedbackItemId, itemId, navigate, routeAgentId]);

  useEffect(() => {
    if (!routeAgentId || !summaryAgentId) return;
    if (!agentsLoaded) return;
    const summaryAgentExists = agents.some(
      (agent) => agent.id === summaryAgentId
    );
    if (!summaryAgentExists) {
      navigate(agentRoute(routeAgentId), { replace: true });
    }
  }, [agents, agentsLoaded, navigate, routeAgentId, summaryAgentId]);

  useEffect(() => {
    if (!validatedSelectedAgentId) return;
    if (connectedAgentId === validatedSelectedAgentId) {
      pendingAutoAttachAgentIdRef.current = null;
      return;
    }
    if (pendingAutoAttachAgentIdRef.current !== validatedSelectedAgentId)
      return;
    pendingAutoAttachAgentIdRef.current = null;
    void ensureTerminalConnected(true, true, validatedSelectedAgentId);
  }, [connectedAgentId, ensureTerminalConnected, validatedSelectedAgentId]);

  useEffect(() => {
    if (routeAgentId) return;
    if (!connectedAgentId) return;
    detachTerminal();
  }, [connectedAgentId, detachTerminal, routeAgentId]);

  const resolveCreateDefaultCwd = useCallback((): string => {
    const activeCwd =
      agentProjectRoot(selectedAgent) || agentProjectRoot(connectedAgent);
    if (activeCwd) return activeCwd;
    const latestAgentCwd = agentProjectRoot(agents[0]);
    if (latestAgentCwd) return latestAgentCwd;
    return "";
  }, [agents, connectedAgent, selectedAgent]);

  const openCreateDialog = useCallback((typeOverride?: AgentType) => {
    setRequestedCreateType(typeOverride ?? null);
    setCreateOpen(true);
  }, []);

  const closeFeedbackDetail = useCallback(() => {
    if (validatedSelectedAgentId) {
      navigate(agentRoute(validatedSelectedAgentId), { replace: true });
      return;
    }
    navigate("/agents", { replace: true });
  }, [navigate, validatedSelectedAgentId]);

  const openFeedbackDetail = useCallback(
    (state: FeedbackDetailState) => {
      if (!state) {
        closeFeedbackDetail();
        return;
      }
      if ("summaryAgentId" in state) {
        navigate(agentReviewRoute(state.parentAgentId, state.summaryAgentId));
        return;
      }
      navigate(agentFeedbackRoute(state.parentAgentId, state.itemId));
    },
    [closeFeedbackDetail, navigate]
  );

  const navigateFeedbackItem = useCallback(
    (parentAgentId: string, nextItemId: number) => {
      navigate(agentFeedbackRoute(parentAgentId, nextItemId));
    },
    [navigate]
  );

  const toggleAgentDetails = useCallback((agentId: string) => {
    setExpandedAgentId((current) => (current === agentId ? null : agentId));
  }, []);

  const ensureAuxExpanded = useCallback((agentId: string) => {
    setExpandedAgentId(agentId);
  }, []);

  const attachToAgent = useCallback(
    async (agent: Agent) => {
      navigate(agentRoute(agent.id));
      ensureAuxExpanded(agent.parentAgentId ?? agent.id);
      refreshMedia(agent.id);
      await ensureTerminalConnected(true, true, agent.id);
    },
    [ensureAuxExpanded, ensureTerminalConnected, navigate, refreshMedia]
  );

  const startAgent = useCallback(
    async (agent: Agent) => {
      navigate(agentRoute(agent.id));
      ensureAuxExpanded(agent.parentAgentId ?? agent.id);
      await api(`/api/v1/agents/${agent.id}/start`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      refreshMedia(agent.id);
      await ensureTerminalConnected(true, true, agent.id);
    },
    [ensureAuxExpanded, ensureTerminalConnected, navigate, refreshMedia]
  );

  const detachAndClearSelection = useCallback(() => {
    detachTerminal();
    navigate("/agents");
  }, [detachTerminal, navigate]);

  const stopAgent = useCallback(
    async (agent: Agent) => {
      if (connectedAgentId === agent.id) {
        detachAndClearSelection();
      }
      await api(`/api/v1/agents/${agent.id}/stop`, {
        method: "POST",
        body: JSON.stringify({ force: false }),
      });
    },
    [connectedAgentId, detachAndClearSelection]
  );

  const deleteAgent = useCallback(
    async (agent: Agent, cleanupWorktree?: string) => {
      if (connectedAgentId === agent.id) {
        detachTerminal();
      }
      setExpandedAgentId((current) => (current === agent.id ? null : current));
      if (routeAgentId === agent.id) {
        navigate("/agents", { replace: true });
      }
      const params = new URLSearchParams();
      if (cleanupWorktree) {
        params.set("cleanupWorktree", cleanupWorktree);
      }
      const qs = params.toString();
      await api(`/api/v1/agents/${agent.id}${qs ? `?${qs}` : ""}`, {
        method: "DELETE",
      });
    },
    [connectedAgentId, detachTerminal, navigate, routeAgentId]
  );

  const borderForAgentState = useCallback((state: AgentVisualState): string => {
    if (state === "active") return "border-r-status-done";
    return "border-r-transparent";
  }, []);

  const mobileCloseAndAction = useCallback(
    <T extends unknown[]>(fn: (...args: T) => void) =>
      (...args: T) => {
        if (isMobile) setMobileLeftOpen(false);
        fn(...args);
      },
    [isMobile, setMobileLeftOpen]
  );

  const handleAgentCreated = useCallback(
    async (agent: Agent, agentType: AgentType) => {
      setCreateOpen(false);
      setRequestedCreateType(null);
      setLastUsedAgentType(agentType);
      navigate(agentRoute(agent.id));
      ensureAuxExpanded(agent.id);
      refreshMedia(agent.id);
      await ensureTerminalConnected(true, true, agent.id);
    },
    [ensureAuxExpanded, ensureTerminalConnected, navigate, refreshMedia]
  );

  const handleCreateOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setRequestedCreateType(null);
    }
    setCreateOpen(open);
  }, []);

  const isAttached = connState === "connected" && Boolean(connectedAgentId);
  const hasActiveAgent = Boolean(validatedSelectedAgentId);

  return (
    <div className="h-full min-h-0 overflow-hidden text-foreground">
      <div className="relative flex h-full min-h-0 min-w-0 overflow-hidden py-2">
        <GlassSidebar
          open={isMobile ? mobileLeftOpen : leftOpen}
          onOpenChange={(open) => {
            if (isMobile) {
              if (open) setMobileMediaOpen(false);
              setMobileLeftOpen(open);
            } else {
              setLeftOpen(open);
            }
          }}
          side="left"
          width={320}
          mobile={isMobile}
          label="Navigation sidebar"
        >
          <SidebarShell
            activeSection="agents"
            onNavigate={onNavigateSection}
            onRequestClose={
              isMobile
                ? () => setMobileLeftOpen(false)
                : () => setLeftOpen(false)
            }
            closeButtonIcon={isMobile ? "x" : "chevron"}
            pulsingNavItem={pulsingNavItem}
            triggerNavAnimation={triggerNavAnimation}
          >
            <AgentListContent
              agents={agents}
              selectedAgentId={validatedSelectedAgentId}
              expandedAgentId={expandedAgentId}
              overflowAgentId={overflowAgentId}
              onOpenCreateDialog={
                isMobile
                  ? mobileCloseAndAction(openCreateDialog)
                  : openCreateDialog
              }
              enabledAgentTypes={enabledAgentTypes}
              enabledIdes={enabledIdes}
              lastUsedAgentType={lastUsedAgentType}
              setOverflowAgentId={setOverflowAgentId}
              setDeleteTarget={setDeleteTarget}
              setDeleteConfirmOpen={
                isMobile
                  ? mobileCloseAndAction(setDeleteConfirmOpen)
                  : setDeleteConfirmOpen
              }
              setStopTarget={setStopTarget}
              setStopConfirmOpen={
                isMobile
                  ? mobileCloseAndAction(setStopConfirmOpen)
                  : setStopConfirmOpen
              }
              agentVisualState={agentVisualState}
              borderForAgentState={borderForAgentState}
              toggleAgentDetails={toggleAgentDetails}
              isFullAccessEnabled={isFullAccessEnabled}
              detachTerminal={detachAndClearSelection}
              attachToAgent={attachToAgent}
              startAgent={startAgent}
              sendTerminalInput={sendTerminalInput}
              connectedAgentId={connectedAgentId}
              onOpenFeedbackDetail={openFeedbackDetail}
              feedbackDetailState={isMobile ? null : feedbackDetail}
              onRequestClose={
                isMobile ? () => setMobileLeftOpen(false) : undefined
              }
              closeOnSessionAction={isMobile}
            />
          </SidebarShell>
        </GlassSidebar>

        <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <div
            className={cn(
              "grid h-full min-h-0 min-w-0 transition-[grid-template-rows] duration-300 ease-in-out",
              isMobile
                ? "grid-rows-[minmax(0,1fr)_auto]"
                : feedbackDetail
                  ? "grid-rows-[minmax(0,1fr)_minmax(0,1fr)]"
                  : "grid-rows-[minmax(0,1fr)_0fr]"
            )}
            onTransitionEnd={(e) => {
              if (e.propertyName === "grid-template-rows" && !feedbackDetail) {
                feedbackDetailStaleRef.current = null;
              }
            }}
          >
            <div className="relative h-full min-h-0 min-w-0">
              {!leftPanelOpen ? (
                <div className="pointer-events-none absolute left-3 top-3 z-10">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="pointer-events-auto"
                    onClick={() => handleSetLeftPanelOpen(true)}
                    title="Open sidebar"
                  >
                    <PanelRightOpen className="h-4 w-4" />
                  </Button>
                </div>
              ) : null}
              <div className="relative h-full min-h-0 min-w-0 pb-14 pt-14">
                {focusedAgent?.name ? (
                  <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex h-14 items-center justify-center px-16">
                    <div
                      data-testid="current-session-name"
                      className="max-w-full truncate text-center text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground"
                    >
                      {focusedAgent.name}
                    </div>
                  </div>
                ) : null}
                {hasActiveAgent && (!mediaPanelOpen || isMobile) ? (
                  <div className="pointer-events-none absolute right-3 top-3 z-10">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="pointer-events-auto relative"
                      onClick={() => setMediaOpen(true)}
                      title="Open media sidebar"
                      data-testid="toggle-media-sidebar"
                    >
                      <PanelLeftOpen className="h-4 w-4" />
                      {unseenMediaCount > 0 ? (
                        <span className="absolute -right-1.5 -top-1.5 min-w-5 rounded-full border border-border bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                          {unseenMediaCount}
                        </span>
                      ) : null}
                    </Button>
                  </div>
                ) : null}
                {connState === "reconnecting" ? (
                  <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden">
                    <div className="dispatch-reconnect-scan h-full w-1/3 will-change-transform bg-[linear-gradient(to_right,transparent,hsl(var(--status-blocked)),hsl(var(--status-waiting)),hsl(var(--status-working)),hsl(var(--status-done)),transparent)] saturate-[1.35] brightness-[1.05] animate-[reconnect-scan_1350ms_ease-in-out_infinite] motion-reduce:animate-none motion-reduce:translate-x-[140%]" />
                  </div>
                ) : null}
                <TerminalPane
                  isAttached={isAttached}
                  connState={connState}
                  statusMessage={statusMessage}
                  terminalMode={terminalMode}
                  terminalPlaceholderMessage={terminalPlaceholderMessage}
                  terminalHostRef={terminalHostRef}
                  resyncing={resyncing}
                  archivePhase={
                    selectedAgent?.status === "archiving"
                      ? selectedAgent.archivePhase
                      : null
                  }
                />
              </div>

              {!isMobile ? (
                <div className="pointer-events-none absolute inset-x-2 bottom-2 z-20">
                  <TerminalCopyModeBannerLayer
                    visible={copyMode === "copy" || copyMode === "exiting"}
                    copyMode={copyMode}
                    onExitCopyMode={() => {
                      void exitCopyMode();
                    }}
                  />
                </div>
              ) : null}
            </div>

            {!isMobile ? (
              <div
                className={cn(
                  "min-h-0 overflow-hidden transition-opacity duration-300",
                  feedbackDetail ? "opacity-100" : "opacity-0"
                )}
              >
                {feedbackDetailRendered ? (
                  "summaryAgentId" in feedbackDetailRendered ? (
                    (() => {
                      const summaryAgent = agents.find(
                        (a) => a.id === feedbackDetailRendered.summaryAgentId
                      );
                      return summaryAgent ? (
                        <ReviewSummaryPanel
                          key={`summary-${feedbackDetailRendered.summaryAgentId}`}
                          parentAgentId={feedbackDetailRendered.parentAgentId}
                          agent={summaryAgent}
                          onClose={closeFeedbackDetail}
                        />
                      ) : null;
                    })()
                  ) : (
                    <FeedbackDetailPanel
                      key={feedbackDetailRendered.parentAgentId}
                      parentAgentId={feedbackDetailRendered.parentAgentId}
                      itemId={feedbackDetailRendered.itemId}
                      isConnected={
                        connectedAgentId ===
                        feedbackDetailRendered.parentAgentId
                      }
                      sendTerminalInput={sendTerminalInput}
                      onClose={closeFeedbackDetail}
                      onNavigate={(nextItemId) =>
                        navigateFeedbackItem(
                          feedbackDetailRendered.parentAgentId,
                          nextItemId
                        )
                      }
                    />
                  )
                ) : null}
              </div>
            ) : null}

            {isMobile ? (
              <MobileTerminalToolbar
                onSendInput={sendTerminalInput}
                onExitCopyMode={() => {
                  void exitCopyMode();
                }}
                ctrlPendingRef={ctrlPendingRef}
                isConnected={
                  connState === "connected" && Boolean(connectedAgentId)
                }
                copyMode={copyMode}
              />
            ) : null}
          </div>
        </main>

        <div className="hidden shrink-0 md:block">
          <MediaSidebar
            mediaOpen={mediaOpen && hasActiveAgent}
            mediaFiles={mediaFiles}
            selectedAgentId={focusedAgentId}
            selectedAgentName={focusedAgent?.name ?? null}
            selectedAgentWorkspaceRoot={
              focusedAgent?.worktreePath ?? focusedAgent?.cwd ?? null
            }
            selectedAgentPins={focusedAgent?.pins ?? []}
            animatingMediaKeys={animatingMediaKeys}
            unseenMediaCount={unseenMediaCount}
            mediaViewportRef={mediaViewportRef}
            setMediaOpen={setMediaOpen}
            activeTab={mediaActiveTab}
            setActiveTab={setMediaActiveTab}
            pinned={mediaPinned}
            onTogglePin={toggleMediaPinned}
            onWidthTransitionEnd={finishMediaResizeSettle}
            hasStream={focusedAgentHasStream}
            streamUrl={focusedAgentStreamUrl}
            openLightbox={openLightbox}
            onUploadFile={uploadFile}
          />
        </div>
      </div>

      {isMobile && feedbackDetail ? (
        "summaryAgentId" in feedbackDetail ? (
          (() => {
            const summaryAgent = agents.find(
              (a) => a.id === feedbackDetail.summaryAgentId
            );
            return summaryAgent ? (
              <MobileReviewSummarySheet
                parentAgentId={feedbackDetail.parentAgentId}
                agent={summaryAgent}
                onClose={closeFeedbackDetail}
              />
            ) : null;
          })()
        ) : (
          <MobileFeedbackSheet
            parentAgentId={feedbackDetail.parentAgentId}
            itemId={feedbackDetail.itemId}
            isConnected={connectedAgentId === feedbackDetail.parentAgentId}
            sendTerminalInput={sendTerminalInput}
            onClose={closeFeedbackDetail}
            onNavigate={(nextItemId) =>
              navigateFeedbackItem(feedbackDetail.parentAgentId, nextItemId)
            }
          />
        )
      ) : null}

      {isMobile ? (
        <GlassSidebar
          open={mobileMediaOpen}
          onOpenChange={(open) => {
            if (open) setMobileLeftOpen(false);
            setMobileMediaOpen(open);
          }}
          side="right"
          mobile={true}
          label="Media sidebar"
        >
          <MediaSidebarContent
            mediaFiles={mediaFiles}
            selectedAgentId={focusedAgentId}
            selectedAgentName={focusedAgent?.name ?? null}
            selectedAgentWorkspaceRoot={
              focusedAgent?.worktreePath ?? focusedAgent?.cwd ?? null
            }
            selectedAgentPins={focusedAgent?.pins ?? []}
            animatingMediaKeys={animatingMediaKeys}
            unseenMediaCount={unseenMediaCount}
            mediaViewportRef={mediaViewportRef}
            activeTab={mediaActiveTab}
            setActiveTab={setMediaActiveTab}
            hasStream={focusedAgentHasStream}
            streamUrl={focusedAgentStreamUrl}
            openLightbox={openLightbox}
            onRequestClose={() => setMobileMediaOpen(false)}
            onUploadFile={uploadFile}
          />
        </GlassSidebar>
      ) : null}

      <CreateAgentDialog
        open={createOpen}
        enabledAgentTypes={enabledAgentTypes}
        initialAgentType={requestedCreateType ?? lastUsedAgentType}
        setOpen={handleCreateOpenChange}
        resolveDefaultCwd={resolveCreateDefaultCwd}
        onCreated={handleAgentCreated}
      />

      <DeleteAgentDialog
        open={deleteConfirmOpen}
        deleteTarget={deleteTarget}
        setOpen={setDeleteConfirmOpen}
        setDeleteTarget={setDeleteTarget}
        onDelete={deleteAgent}
      />

      <StopAgentDialog
        open={stopConfirmOpen}
        stopTarget={stopTarget}
        setOpen={setStopConfirmOpen}
        setStopTarget={setStopTarget}
        onStop={stopAgent}
      />

      <MediaLightbox
        item={lightboxItem}
        currentIndex={lightboxIndex}
        totalItems={mediaFiles.length}
        setLightboxIndex={setLightboxIndex}
      />

      <div className="sr-only" aria-live="polite">
        {statusMessage}
      </div>
    </div>
  );
}
