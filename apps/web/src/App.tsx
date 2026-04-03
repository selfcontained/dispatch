import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { AgentSidebar, AgentSidebarContent } from "@/components/app/agent-sidebar";
import { AppHeader } from "@/components/app/app-header";
import { ActivityPane } from "@/components/app/activity-pane";
import { DocsPane } from "@/components/app/docs-pane";
import { LoginPage } from "@/components/app/login-page";
import { SettingsPane } from "@/components/app/settings-pane";
import { CreateAgentDialog } from "@/components/app/create-agent-dialog";
import { DeleteAgentDialog } from "@/components/app/delete-agent-dialog";
import { StopAgentDialog } from "@/components/app/stop-agent-dialog";
import { MediaLightbox } from "@/components/app/media-lightbox";
import { MediaSidebar, MediaSidebarContent } from "@/components/app/media-sidebar";
import { MobileTerminalToolbar } from "@/components/app/mobile-terminal-toolbar";
import { StatusFooter } from "@/components/app/status-footer";
import { TerminalPane } from "@/components/app/terminal-pane";
import { type FeedbackDetailState, FeedbackDetailPanel } from "@/components/app/feedback-panel";
import {
  type Agent,
  type AgentVisualState,
  type ServiceState,
} from "@/components/app/types";
import { MobileSlidePanel } from "@/components/ui/mobile-slide-panel";
import { cn } from "@/lib/utils";
import { initEnergyMetrics } from "@/lib/energy-metrics";
import { api } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { useHealth } from "@/hooks/use-health";
import { useLayout } from "@/hooks/use-layout";
import { useAgents } from "@/hooks/use-agents";
import { useSSE } from "@/hooks/use-sse";
import { useMedia } from "@/hooks/use-media";
import { useTerminal } from "@/hooks/use-terminal";
import { useIconColor } from "@/hooks/use-icon-color";
import { useTheme } from "@/hooks/use-theme";
import { useAgentFocus } from "@/hooks/use-agent-focus";
import { AGENT_TYPES, type AgentType, isAgentType, sanitizeEnabledAgentTypes } from "@/lib/agent-types";

const CODEX_FULL_ACCESS_ARG = "--dangerously-bypass-approvals-and-sandbox";
const CLAUDE_FULL_ACCESS_ARG = "--dangerously-skip-permissions";
const LAST_USED_CWD_KEY = "dispatch:lastUsedAgentCwd";
const LAST_USED_TYPE_KEY = "dispatch:lastUsedAgentType";
const CWD_HISTORY_KEY = "dispatch:cwdHistory";
const CWD_HISTORY_MAX = 20;

/** Return the project root for an agent, preferring gitContext.repoRoot over cwd (which may be a worktree path). */
function agentProjectRoot(agent: Agent | undefined | null): string | undefined {
  return agent?.gitContext?.repoRoot?.trim() || agent?.cwd?.trim() || undefined;
}

function readLastUsedCwd(): string {
  if (typeof window === "undefined") return "";
  const stored = window.localStorage.getItem(LAST_USED_CWD_KEY)?.trim();
  return stored && stored.length > 0 ? stored : "~/";
}

function readLastUsedAgentType(): AgentType | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(LAST_USED_TYPE_KEY)?.trim();
  return stored && isAgentType(stored) ? stored : null;
}

function readCwdHistory(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CWD_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
  } catch {
    return [];
  }
}

function addToCwdHistory(cwd: string): string[] {
  const trimmed = cwd.trim();
  if (!trimmed) return readCwdHistory();
  const existing = readCwdHistory().filter((entry) => entry !== trimmed);
  const updated = [trimmed, ...existing].slice(0, CWD_HISTORY_MAX);
  window.localStorage.setItem(CWD_HISTORY_KEY, JSON.stringify(updated));
  return updated;
}

function removeCwdFromHistory(cwd: string): string[] {
  const current = readCwdHistory().filter((entry) => entry !== cwd);
  window.localStorage.setItem(CWD_HISTORY_KEY, JSON.stringify(current));
  return current;
}

function isFullAccessEnabled(agent: Pick<Agent, "fullAccess" | "agentArgs">): boolean {
  return (
    agent.fullAccess ||
    agent.agentArgs.includes(CODEX_FULL_ACCESS_ARG) ||
    agent.agentArgs.includes(CLAUDE_FULL_ACCESS_ARG)
  );
}

export function App(): JSX.Element {
  // ── Theme & Branding ──────────────────────────────────────────────────
  const { theme, setTheme } = useTheme();
  const { iconColor, setIconColor, isLoading: isIconColorSaving, error: iconColorError, clearError: clearIconColorError } = useIconColor();

  // ── Auth ──────────────────────────────────────────────────────────────
  const { authState, handleAuthenticated, handleLogout } = useAuth();

  // ── Layout ────────────────────────────────────────────────────────────
  const {
    isMobile,
    leftOpen,
    mediaOpen,
    leftPanelOpen,
    mediaPanelOpen,
    mobileLeftOpen,
    mobileMediaOpen,
    setLeftOpen,
    setMediaOpen,
    setMobileLeftOpen,
    setMobileMediaOpen,
    handleSetLeftPanelOpen,
    handleSetMediaPanelOpen,
  } = useLayout();

  // ── Health ────────────────────────────────────────────────────────────
  const { apiState, dbState } = useHealth(authState === "authenticated");

  // ── Media ─────────────────────────────────────────────────────────────
  // (selectedAgentId comes from useAgents below — we forward-declare the ref)
  const selectedAgentIdRef = useRef<string | null>(null);

  // We need selectedAgentId before calling useMedia, but useAgents needs
  // connectedAgentId from useTerminal.  Break the cycle by keeping
  // connectedAgentId in a ref from useTerminal.

  // ── Create dialog state ───────────────────────────────────────────────
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createCwd, setCreateCwd] = useState(() => readLastUsedCwd());
  const [createCwdInitialized, setCreateCwdInitialized] = useState(() => readLastUsedCwd().trim().length > 0);
  const [enabledAgentTypes, setEnabledAgentTypes] = useState<AgentType[]>([...AGENT_TYPES]);
  const [lastUsedAgentType, setLastUsedAgentType] = useState<AgentType | null>(() => readLastUsedAgentType());
  const [createType, setCreateType] = useState<AgentType>("codex");
  const [createFullAccess, setCreateFullAccess] = useState(false);
  const [createUseWorktree, setCreateUseWorktree] = useState(true);
  const [createWorktreeBranch, setCreateWorktreeBranch] = useState("");
  const [createBaseBranch, setCreateBaseBranch] = useState("main");
  const [creating, setCreating] = useState(false);
  const [cwdHistory, setCwdHistory] = useState<string[]>(() => readCwdHistory());

  // ── Delete dialog state ───────────────────────────────────────────────
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Agent | null>(null);
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [stopTarget, setStopTarget] = useState<Agent | null>(null);

  // ── Panes ─────────────────────────────────────────────────────────────
  const [settingsPaneOpen, setSettingsPaneOpen] = useState(false);
  const [docsPaneOpen, setDocsPaneOpen] = useState(false);
  const [feedbackDetail, setFeedbackDetail] = useState<FeedbackDetailState>(null);
  const [activityPaneOpen, setActivityPaneOpen] = useState(false);
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);

  // ── Agents (placeholder connectedAgentId — filled by terminal hook) ──
  // We use a temporary variable; useAgents only needs connectedAgentId for
  // sorting/visual state.  useTerminal returns it.  We'll resolve this by
  // lifting connectedAgentId as shared state.
  const [sharedConnectedAgentId, setSharedConnectedAgentId] = useState<string | null>(null);
  const [sharedConnState, setSharedConnState] = useState<"disconnected" | "reconnecting" | "connected">("disconnected");

  const {
    agents,
    agentsLoaded,
    selectedAgentId,
    setSelectedAgentId,
    selectedAgent,
    connectedAgent,
    overflowAgentId,
    setOverflowAgentId,
    streamingAgentIds,
    setStreamingAgentIds,
    agentVisualState,
    resortAgents,
  } = useAgents(sharedConnectedAgentId, sharedConnState, authState === "authenticated");

  selectedAgentIdRef.current = selectedAgentId;

  const focusedAgentId = sharedConnState === "connected" || sharedConnState === "reconnecting"
    ? (sharedConnectedAgentId ?? selectedAgentId)
    : null;
  const focusedAgent = focusedAgentId
    ? agents.find((agent) => agent.id === focusedAgentId) ?? null
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
    markSeenInCache,
  } = useMedia(focusedAgentId, mediaPanelOpen);

  const focusedAgentHasStream = focusedAgentId ? streamingAgentIds.has(focusedAgentId) : false;
  const focusedAgentStreamUrl = focusedAgentId ? `/api/v1/agents/${focusedAgentId}/stream` : null;

  const ensureAuxExpanded = useCallback((agentId: string) => {
    setExpandedAgentId((current) => {
      if (current === null || current === agentId) {
        return agentId;
      }
      return current;
    });
  }, []);

  // ── Terminal ──────────────────────────────────────────────────────────
  const onAgentSelected = useCallback(
    (agentId: string) => {
      setSelectedAgentId(agentId);
      ensureAuxExpanded(agentId);
    },
    [ensureAuxExpanded, setSelectedAgentId]
  );

  const {
    connState,
    connectedAgentId,
    terminalMode,
    terminalPlaceholderMessage,
    statusMessage,
    terminalHostRef,
    ctrlPendingRef,
    focusTerminal,
    ensureTerminalConnected,
    detachTerminal,
    sendTerminalInput,
  } = useTerminal({
    authState,
    agents,
    agentsLoaded,
    selectedAgentId,
    theme,
    isMobile,
    leftOpen,
    mediaOpen,
    onAgentSelected,
    refreshMedia,
  });

  // Sync terminal's connectedAgentId/connState into shared state for useAgents.
  useEffect(() => {
    setSharedConnectedAgentId(connectedAgentId);
  }, [connectedAgentId]);

  useEffect(() => {
    setSharedConnState(connState);
  }, [connState]);

  useEffect(() => {
    if (expandedAgentId && agents.some((agent) => agent.id === expandedAgentId)) {
      return;
    }
    setExpandedAgentId(null);
  }, [agents, expandedAgentId]);

  // Re-sort agents when connected agent changes.
  useEffect(() => {
    resortAgents();
  }, [connectedAgentId, resortAgents]);

  // Close feedback detail panel when the connected agent changes.
  useEffect(() => {
    setFeedbackDetail((prev) => prev && connectedAgentId !== prev.parentAgentId ? null : prev);
  }, [connectedAgentId]);

  const connectedAgentIdRef = useRef<string | null>(null);
  connectedAgentIdRef.current = connectedAgentId;

  // ── Focus tracking (notification suppression) ─────────────────────────
  useAgentFocus(focusedAgentId, authState);

  // ── SSE ───────────────────────────────────────────────────────────────
  useSSE(authState, connectedAgentIdRef, selectedAgentIdRef, setStreamingAgentIds, markSeenInCache);

  // Return focus to the terminal when either sidebar closes.
  const prevLeftOpenRef = useRef(leftPanelOpen);
  const prevMediaOpenRef = useRef(mediaPanelOpen);
  useEffect(() => {
    const leftClosed = prevLeftOpenRef.current && !leftPanelOpen;
    const mediaClosed = prevMediaOpenRef.current && !mediaPanelOpen;
    prevLeftOpenRef.current = leftPanelOpen;
    prevMediaOpenRef.current = mediaPanelOpen;
    if (leftClosed || mediaClosed) {
      // Delay slightly so the sidebar close animation doesn't steal focus.
      const timer = window.setTimeout(focusTerminal, 50);
      return () => window.clearTimeout(timer);
    }
  }, [leftPanelOpen, mediaPanelOpen, focusTerminal]);

  // ── Energy metrics ────────────────────────────────────────────────────
  useEffect(() => {
    return initEnergyMetrics();
  }, []);

  // ── Overflow menu close on outside click ──────────────────────────────
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-radix-popper-content-wrapper]") && !target.closest("[data-agent-control='true']")) {
        setOverflowAgentId(null);
      }
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [setOverflowAgentId]);

  // ── Persist last-used CWD ─────────────────────────────────────────────
  useEffect(() => {
    const lastUsedCwd = agentProjectRoot(connectedAgent) || agentProjectRoot(selectedAgent);
    if (lastUsedCwd) {
      window.localStorage.setItem(LAST_USED_CWD_KEY, lastUsedCwd);
    }
  }, [connectedAgent, selectedAgent]);

  // ── Fetch system defaults for create dialog CWD ───────────────────────
  useEffect(() => {
    if (createCwdInitialized) return;
    let cancelled = false;
    void api<{ homeDir: string }>("/api/v1/system/defaults")
      .then((payload) => {
        if (cancelled) return;
        setCreateCwd(payload.homeDir);
        setCreateCwdInitialized(true);
      })
      .catch(() => {
        if (cancelled) return;
        setCreateCwdInitialized(true);
      });
    return () => { cancelled = true; };
  }, [createCwdInitialized]);

  useEffect(() => {
    let cancelled = false;

    void api<{ enabledAgentTypes: AgentType[] }>("/api/v1/app/settings/agent-types")
      .then((payload) => {
        if (cancelled) return;
        setEnabledAgentTypes(sanitizeEnabledAgentTypes(payload.enabledAgentTypes));
      })
      .catch(() => {
        if (cancelled) return;
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (enabledAgentTypes.includes(createType)) {
      return;
    }
    setCreateType(enabledAgentTypes[0] ?? "codex");
  }, [createType, enabledAgentTypes]);

  // ── Derived values ────────────────────────────────────────────────────
  const isAttached = connState === "connected" && Boolean(connectedAgentId);
  const showHeaderStatus = connState !== "disconnected";

  const statusText = useMemo(() => {
    if (connState === "reconnecting") {
      if (connectedAgent) return `Reconnecting to session ${connectedAgent.name}...`;
      return "Reconnecting session...";
    }
    if (connState === "connected" && connectedAgent) {
      if (connectedAgent.latestEvent?.message) return connectedAgent.latestEvent.message;
      return `Connected to session ${connectedAgent.name}`;
    }
    if (apiState === "down") return "Unable to reach API service.";
    return "Tap an agent row to focus it.";
  }, [apiState, connectedAgent, connState]);

  // ── Agent action callbacks ────────────────────────────────────────────
  const resolveCreateDefaultCwd = useCallback((): string => {
    const activeCwd = agentProjectRoot(selectedAgent) || agentProjectRoot(connectedAgent);
    if (activeCwd) return activeCwd;
    const latestAgentCwd = agentProjectRoot(agents[0]);
    if (latestAgentCwd) return latestAgentCwd;
    return readLastUsedCwd();
  }, [agents, connectedAgent, selectedAgent]);

  const openCreateDialog = useCallback((typeOverride?: AgentType) => {
    setCreateCwd(resolveCreateDefaultCwd());
    if (typeOverride && enabledAgentTypes.includes(typeOverride)) {
      setCreateType(typeOverride);
    } else {
      setCreateType((current) => (enabledAgentTypes.includes(current) ? current : enabledAgentTypes[0] ?? "codex"));
    }
    setCreateOpen(true);
  }, [enabledAgentTypes, resolveCreateDefaultCwd]);

  const toggleAgentDetails = useCallback(
    (agentId: string) => {
      setExpandedAgentId((current) => (current === agentId ? null : agentId));
    },
    []
  );

  const attachToAgent = useCallback(
    async (agent: Agent) => {
      setSelectedAgentId(agent.id);
      ensureAuxExpanded(agent.id);
      refreshMedia(agent.id);
      await ensureTerminalConnected(true, true, agent.id);
    },
    [ensureAuxExpanded, ensureTerminalConnected, refreshMedia, setSelectedAgentId]
  );

  const startAgent = useCallback(
    async (agent: Agent) => {
      setSelectedAgentId(agent.id);
      ensureAuxExpanded(agent.id);
      await api(`/api/v1/agents/${agent.id}/start`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      refreshMedia(agent.id);
      await ensureTerminalConnected(true, true, agent.id);
    },
    [ensureAuxExpanded, ensureTerminalConnected, refreshMedia, setSelectedAgentId]
  );

  const detachAndClearSelection = useCallback(() => {
    detachTerminal();
    setSelectedAgentId(null);
  }, [detachTerminal, setSelectedAgentId]);

  const stopAgent = useCallback(
    async (agent: Agent) => {
      if (connectedAgentId === agent.id) {
        detachAndClearSelection();
      }
      await api(`/api/v1/agents/${agent.id}/stop`, {
        method: "POST",
        body: JSON.stringify({ force: true }),
      });
    },
    [connectedAgentId, detachAndClearSelection]
  );

  const deleteAgent = useCallback(
    async (agent: Agent, cleanupWorktree?: string) => {
      if (connectedAgentId === agent.id) {
        detachTerminal();
      }
      if (selectedAgentId === agent.id) {
        setSelectedAgentId(null);
        refreshMedia(null);
      }
      if (agent.status === "running") {
        await api(`/api/v1/agents/${agent.id}/stop`, {
          method: "POST",
          body: JSON.stringify({ force: true }),
        });
      }
      const params = new URLSearchParams();
      if (cleanupWorktree) {
        params.set("cleanupWorktree", cleanupWorktree);
      }
      const qs = params.toString();
      await api(`/api/v1/agents/${agent.id}${qs ? `?${qs}` : ""}`, { method: "DELETE" });
    },
    [connectedAgentId, detachTerminal, refreshMedia, selectedAgentId, setSelectedAgentId]
  );

  const handleRemoveCwdHistory = useCallback((cwd: string) => {
    setCwdHistory(removeCwdFromHistory(cwd));
  }, []);

  const handleCreateAgent = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!createCwd.trim()) return;

      setCreating(true);

      try {
        const payload = await api<{ agent: Agent }>("/api/v1/agents", {
          method: "POST",
          body: JSON.stringify({
            name: createName.trim(),
            cwd: createCwd.trim(),
            type: createType,
            fullAccess: createFullAccess,
            useWorktree: createUseWorktree,
            worktreeBranch: createWorktreeBranch.trim() || undefined,
            baseBranch: createBaseBranch !== "main" ? createBaseBranch : undefined,
          }),
        });

        setCreateOpen(false);
        setCreateName("");
        setCreateFullAccess(false);
        setCreateUseWorktree(true);
        setCreateWorktreeBranch("");
        setCreateBaseBranch("main");
        window.localStorage.setItem(LAST_USED_CWD_KEY, createCwd.trim());
        window.localStorage.setItem(LAST_USED_TYPE_KEY, createType);
        setLastUsedAgentType(createType);
        setCwdHistory(addToCwdHistory(createCwd.trim()));
        setSelectedAgentId(payload.agent.id);
        ensureAuxExpanded(payload.agent.id);
        refreshMedia(payload.agent.id);
        // Small delay to let tmux session start before connecting
        setTimeout(() => void ensureTerminalConnected(true, true, payload.agent.id), 300);
      } finally {
        setCreating(false);
      }
    },
    [createBaseBranch, createCwd, createFullAccess, createName, createType, createUseWorktree, createWorktreeBranch, ensureAuxExpanded, ensureTerminalConnected, refreshMedia, setSelectedAgentId]
  );

  const borderForAgentState = (state: AgentVisualState): string => {
    if (state === "active") return "border-r-status-done";
    return "border-r-transparent";
  };

  const serviceDotClass = (state: ServiceState): string => {
    if (state === "ok") return "bg-status-working";
    if (state === "down") return "bg-status-blocked";
    return "bg-status-waiting";
  };

  // ── Render ────────────────────────────────────────────────────────────
  if (authState === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
        <span className="text-sm">Loading...</span>
      </div>
    );
  }

  if (authState === "needs-login") {
    return <LoginPage onAuthenticated={handleAuthenticated} />;
  }

  return (
    <div className="h-full min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex h-full min-h-0 min-w-0 overflow-hidden">
        {!isMobile ? (
          <div className="shrink-0">
            <AgentSidebar
              leftOpen={leftOpen}
              agents={agents}
              selectedAgentId={selectedAgentId}
              expandedAgentId={expandedAgentId}
              overflowAgentId={overflowAgentId}
              setLeftOpen={setLeftOpen}
              onOpenCreateDialog={openCreateDialog}
              enabledAgentTypes={enabledAgentTypes}
              lastUsedAgentType={lastUsedAgentType}
              onOpenDocs={() => setDocsPaneOpen(true)}
              onOpenActivity={() => setActivityPaneOpen(true)}
              onOpenSettings={() => setSettingsPaneOpen(true)}
              setOverflowAgentId={setOverflowAgentId}
              setDeleteTarget={setDeleteTarget}
              setDeleteConfirmOpen={setDeleteConfirmOpen}
              setStopTarget={setStopTarget}
              setStopConfirmOpen={setStopConfirmOpen}
              agentVisualState={agentVisualState}
              borderForAgentState={borderForAgentState}
              toggleAgentDetails={toggleAgentDetails}
              isFullAccessEnabled={isFullAccessEnabled}
              detachTerminal={detachTerminal}
              attachToAgent={attachToAgent}
              startAgent={startAgent}
              sendTerminalInput={sendTerminalInput}
              connectedAgentId={connectedAgentId}
              onOpenFeedbackDetail={setFeedbackDetail}
            />
          </div>
        ) : null}

        <main
          className={cn("min-h-0 min-w-0 flex-1 overflow-hidden", mediaOpen && !isMobile && "border-r-2 border-border")}
        >
          <div
            className={cn(
              "grid h-full min-h-0 min-w-0 transition-[grid-template-rows] duration-300 ease-in-out",
              isMobile
                ? "grid-rows-[auto_1fr_auto_auto]"
                : feedbackDetail
                  ? "grid-rows-[auto_1fr_1fr_auto]"
                  : "grid-rows-[auto_1fr_0fr_auto]"
            )}
          >
            <AppHeader
              leftOpen={leftPanelOpen}
              mediaOpen={mediaPanelOpen}
              isMobile={isMobile}
              showHeaderStatus={showHeaderStatus}
              statusText={statusText}
              showReconnectIndicator={connState === "reconnecting"}
              isAttached={isAttached}
              unseenMediaCount={unseenMediaCount}
              setLeftOpen={handleSetLeftPanelOpen}
              setMediaOpen={handleSetMediaPanelOpen}
              detachTerminal={detachAndClearSelection}
            />

            <TerminalPane
              isAttached={isAttached}
              connState={connState}
              statusMessage={statusMessage}
              terminalMode={terminalMode}
              terminalPlaceholderMessage={terminalPlaceholderMessage}
              terminalHostRef={terminalHostRef}
            />

            {!isMobile ? (
              <div className={cn("min-h-0 overflow-hidden transition-opacity duration-300", feedbackDetail ? "opacity-100" : "opacity-0")}>
                {feedbackDetail ? (
                  <FeedbackDetailPanel
                    key={feedbackDetail.parentAgentId}
                    parentAgentId={feedbackDetail.parentAgentId}
                    itemId={feedbackDetail.itemId}
                    isConnected={connectedAgentId === feedbackDetail.parentAgentId}
                    sendTerminalInput={sendTerminalInput}
                    onClose={() => setFeedbackDetail(null)}
                    onNavigate={(itemId) => setFeedbackDetail((prev) => prev ? { ...prev, itemId } : null)}
                  />
                ) : null}
              </div>
            ) : null}

            {isMobile ? <MobileTerminalToolbar onSendInput={sendTerminalInput} ctrlPendingRef={ctrlPendingRef} /> : null}

            <StatusFooter
              apiState={apiState}
              dbState={dbState}
              serviceDotClass={serviceDotClass}
            />
          </div>
        </main>

        <div className="hidden shrink-0 md:block">
          <MediaSidebar
            mediaOpen={mediaOpen}
            mediaFiles={mediaFiles}
            selectedAgentId={focusedAgentId}
            selectedAgentName={focusedAgent?.name ?? null}
            animatingMediaKeys={animatingMediaKeys}

            mediaViewportRef={mediaViewportRef}
            setMediaOpen={setMediaOpen}
            hasStream={focusedAgentHasStream}
            streamUrl={focusedAgentStreamUrl}
            openLightbox={openLightbox}
          />
        </div>
      </div>

      {isMobile ? (
        <MobileSlidePanel
          open={mobileLeftOpen}
          side="left"
          label="Agent sidebar"
          onOpenChange={(open) => {
            if (open) setMobileMediaOpen(false);
            setMobileLeftOpen(open);
          }}
        >
          <AgentSidebarContent
            agents={agents}
            selectedAgentId={selectedAgentId}
            expandedAgentId={expandedAgentId}
            overflowAgentId={overflowAgentId}
            onOpenCreateDialog={(type?: AgentType) => { setMobileLeftOpen(false); openCreateDialog(type); }}
            enabledAgentTypes={enabledAgentTypes}
            lastUsedAgentType={lastUsedAgentType}
            onOpenDocs={() => { setMobileLeftOpen(false); setDocsPaneOpen(true); }}
            onOpenActivity={() => { setMobileLeftOpen(false); setActivityPaneOpen(true); }}
            onOpenSettings={() => { setMobileLeftOpen(false); setSettingsPaneOpen(true); }}
            setOverflowAgentId={setOverflowAgentId}
            setDeleteTarget={setDeleteTarget}
            setDeleteConfirmOpen={(open) => { if (open) setMobileLeftOpen(false); setDeleteConfirmOpen(open); }}
            setStopTarget={setStopTarget}
            setStopConfirmOpen={(open) => { if (open) setMobileLeftOpen(false); setStopConfirmOpen(open); }}
            agentVisualState={agentVisualState}
            borderForAgentState={borderForAgentState}
            toggleAgentDetails={toggleAgentDetails}
            isFullAccessEnabled={isFullAccessEnabled}
            detachTerminal={detachAndClearSelection}
            attachToAgent={attachToAgent}
            startAgent={startAgent}
            sendTerminalInput={sendTerminalInput}
            connectedAgentId={connectedAgentId}
            closeOnSessionAction={true}
            onRequestClose={() => setMobileLeftOpen(false)}
          />
        </MobileSlidePanel>
      ) : null}

      {isMobile ? (
        <MobileSlidePanel
          open={mobileMediaOpen}
          side="right"
          label="Media sidebar"
          onOpenChange={(open) => {
            if (open) setMobileLeftOpen(false);
            setMobileMediaOpen(open);
          }}
        >
            <MediaSidebarContent
              mediaFiles={mediaFiles}
              selectedAgentId={focusedAgentId}
              selectedAgentName={focusedAgent?.name ?? null}
              animatingMediaKeys={animatingMediaKeys}
  
              mediaViewportRef={mediaViewportRef}
              hasStream={focusedAgentHasStream}
              streamUrl={focusedAgentStreamUrl}
              openLightbox={openLightbox}
              onRequestClose={() => setMobileMediaOpen(false)}
            />
        </MobileSlidePanel>
      ) : null}

      <CreateAgentDialog
        open={createOpen}
        createName={createName}
        createType={createType}
        createCwd={createCwd}
        createFullAccess={createFullAccess}
        createUseWorktree={createUseWorktree}
        createWorktreeBranch={createWorktreeBranch}
        createBaseBranch={createBaseBranch}
        creating={creating}
        cwdHistory={cwdHistory}
        enabledAgentTypes={enabledAgentTypes}
        setOpen={setCreateOpen}
        setCreateName={setCreateName}
        setCreateType={setCreateType}
        setCreateCwd={setCreateCwd}
        setCreateFullAccess={setCreateFullAccess}
        setCreateUseWorktree={setCreateUseWorktree}
        setCreateWorktreeBranch={setCreateWorktreeBranch}
        setCreateBaseBranch={setCreateBaseBranch}
        onSubmit={handleCreateAgent}
        onRemoveCwdHistory={handleRemoveCwdHistory}
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

      <DocsPane open={docsPaneOpen} onClose={() => setDocsPaneOpen(false)} />
      {activityPaneOpen ? (
        <ActivityPane open={activityPaneOpen} onClose={() => setActivityPaneOpen(false)} />
      ) : null}
      <SettingsPane
        open={settingsPaneOpen}
        onClose={() => setSettingsPaneOpen(false)}
        onLogout={handleLogout}
        theme={theme}
        setTheme={setTheme}
        iconColor={iconColor}
        setIconColor={setIconColor}
        isIconColorSaving={isIconColorSaving}
        iconColorError={iconColorError}
        clearIconColorError={clearIconColorError}
        enabledAgentTypes={enabledAgentTypes}
        onEnabledAgentTypesChange={setEnabledAgentTypes}
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
