import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Routes, Route, useNavigate, useParams } from "react-router-dom";
import { useAtom, useAtomValue } from "jotai";

import {
  type AgentPaneView,
  bottomBarCollapsedAtom,
  chatShowChildAgentsAtom,
  type CenterTab,
  whiteboardAgentDrewAtomFamily,
} from "@/lib/store";

import { AgentPane, AgentViewToggle } from "@/components/app/agent-pane";
import { ChangesTab } from "@/components/app/changes-tab";
import { WhiteboardPane } from "@/components/app/whiteboard-pane";
import { SplitDropZones } from "@/components/app/split-drop-zones";
import { CenterPaneSplit } from "@/components/app/center-pane-split";
import { useVisibleDiffStats } from "@/hooks/use-agent-diff-stats";
import { useCenterPaneLayout } from "@/hooks/use-center-pane-layout";

import { AgentListContent } from "@/components/app/agent-sidebar";
import { AgentsViewHeader } from "@/components/app/agents-view-header";
import {
  agentProjectRoot,
  isFullAccessEnabled,
  readLastUsedAgentType,
} from "@/components/app/agents-view-utils";
import { AgentsViewDialogs } from "@/components/app/agents-view-dialogs";
import {
  MediaSidebar,
  MediaSidebarContent,
} from "@/components/app/media-sidebar";
import { BottomBar } from "@/components/app/bottom-bar";
import { TerminalCopyModeBannerLayer } from "@/components/app/terminal-copy-mode-banner";
import { MobileTerminalToolbar } from "@/components/app/mobile-terminal-toolbar";
import { SidebarShell, type NavSection } from "@/components/app/sidebar-shell";
import { TerminalPane } from "@/components/app/terminal-pane";
import {
  type Agent,
  type AgentVisualState,
  type ConnState,
} from "@/components/app/types";
import { GlassSidebar } from "@/components/ui/glass-sidebar";
import { uploadAgentMedia } from "@/lib/media-upload";
import { type AgentType } from "@/lib/agent-types";
import { agentSupportsChat, terminalHostTab } from "@/lib/center-tabs";
import { type IdeType } from "@/lib/ide-types";
import { type ThemeId } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";
import { useAgentActions } from "@/hooks/use-agent-actions";
import { useAgentPaneView } from "@/hooks/use-agent-pane-view";
import {
  useAgentUnreadCount,
  useMarkMessagesRead,
} from "@/hooks/use-agent-messages";
import { useAgents } from "@/hooks/use-agents";
import { useAgentSurfaces } from "@/hooks/use-agent-surfaces";
import { useChatSurfaceEnabled } from "@/hooks/use-chat-surface-enabled";
import { useAgentChatUnread } from "@/hooks/use-chat-unread-summary";
import { useSurfaceSeen } from "@/components/app/agent-surfaces/use-surface-seen";
import { useMedia } from "@/hooks/use-media";
import { useMediaSidebarState } from "@/hooks/use-media-sidebar-state";
import { useTerminal } from "@/hooks/use-terminal";
import { useAgentFocus } from "@/hooks/use-agent-focus";
import { useAgentsViewRouting } from "@/hooks/use-agents-view-routing";
import { useAgentHotkeys } from "@/hooks/use-agent-hotkeys";
import {
  useExpandedAgent,
  useExpandedAgentSync,
} from "@/hooks/use-expanded-agent";

type AgentsViewProps = {
  enabledAgentTypes: AgentType[];
  enabledIdes: IdeType[];
  isMobile: boolean;
  theme: ThemeId;
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
  theme,
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
  const { agentId: routeAgentId } = useParams();
  const navTo = useNavigate();

  const [sharedConnectedAgentId, setSharedConnectedAgentId] = useState<
    string | null
  >(null);
  const [sharedConnState, setSharedConnState] =
    useState<ConnState>("disconnected");
  const [showChildAgents, setShowChildAgents] = useAtom(
    chatShowChildAgentsAtom
  );

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

  const { changesMatch, whiteboardMatch, centerTabResolved, onTabChange } =
    useAgentsViewRouting({
      routeAgentId,
      agentsLoaded,
      validatedSelectedAgentId,
      routeAgentType: selectedAgent?.type ?? null,
    });
  const { enabled: chatSurfaceEnabled } = useChatSurfaceEnabled();
  // The terminal DOM stays mounted (hidden) across tab switches so tmux
  // output keeps flowing into it, but it must not mount at all until the
  // route has settled on a tab: on a fresh navigation the Console would
  // otherwise paint for a frame before the Chat redirect lands. Once armed
  // it stays armed — a later agent switch must not tear xterm down.
  const [terminalArmed, setTerminalArmed] = useState(false);
  if (centerTabResolved && !terminalArmed) setTerminalArmed(true);
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

  const { expandedAgentId, setExpandedAgentId, toggleAgentDetails } =
    useExpandedAgent();

  const pendingAutoAttachAgentIdRef = useRef<string | null>(null);
  const sidebarAgentId = sharedConnectedAgentId ?? validatedSelectedAgentId;
  const agentIds = useMemo(() => agents.map((a) => a.id), [agents]);
  const {
    mediaOpen,
    mediaPanelOpen,
    mediaActiveTab,
    mediaPinned,
    deferMediaResize,
    mediaResizeSettleKey,
    setMediaOpen,
    setMediaActiveTab,
    toggleMediaPinned,
    finishMediaResizeSettle,
  } = useMediaSidebarState({
    sidebarAgentId,
    isMobile,
    agentIds: agentsLoaded ? agentIds : [],
    mobileMediaOpen,
    setMobileLeftOpen,
    setMobileMediaOpen,
  });

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
    draggingFiles,
    uploadingFiles,
    terminalInputAtRef,
  } = useTerminal({
    authState: "authenticated",
    agents,
    selectedAgentId: validatedSelectedAgentId,
    theme,
    isMobile,
    leftOpen,
    deferMediaResize,
    mediaResizeSettleKey,
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
  // The flag as it applies to the agent in focus: a terminal session has no
  // CLI to chat with, so it keeps the plain Terminal tab and Console-only
  // pane however the flag is set. An empty workspace likewise has no Chat
  // target and should not render the Agent-pane view switch.
  const chatEnabled =
    chatSurfaceEnabled &&
    focusedAgent !== null &&
    agentSupportsChat(focusedAgent.type);
  const activeTab: CenterTab = changesMatch
    ? "changes"
    : whiteboardMatch
      ? "whiteboard"
      : terminalHostTab(chatEnabled);

  const whiteboardAgentDrew = useAtomValue(
    whiteboardAgentDrewAtomFamily(focusedAgentId ?? "")
  );
  const bottomBarCollapsed = useAtomValue(bottomBarCollapsedAtom);

  const {
    splitState,
    isSplit,
    exitSplit,
    isDraggingTab,
    splitLeftRef,
    splitButtonRef,
    defaultTerminalSlotRef,
    splitTerminalSlotRef,
    stableTerminalContainer,
    handleContentDragOver,
    handleContentDragLeave,
    handleContentDrop,
    handleDropOnZone,
    handleSplitLayoutChange,
  } = useCenterPaneLayout({
    focusedAgentId,
    isMobile,
    activeTab,
    chatEnabled,
  });

  // The focused agent's direct children, whose pins and media the sidebar
  // groups under it. Direct children only — the same family the server's
  // ownerAgentId reads allow — and live ones only, since this is the live
  // agent list; an archived child's media stays reachable from its history.
  const focusedSubAgents = useMemo(
    () =>
      focusedAgentId
        ? agents
            .filter((agent) => agent.parentAgentId === focusedAgentId)
            .map((agent) => ({
              id: agent.id,
              name: agent.name,
              status: agent.status,
              workspaceRoot: agent.worktreePath ?? agent.cwd ?? null,
            }))
        : [],
    [agents, focusedAgentId]
  );
  const focusedSubAgentIds = useMemo(
    () => focusedSubAgents.map((agent) => agent.id),
    [focusedSubAgents]
  );
  const focusedSubAgentPins = useMemo(
    () =>
      focusedSubAgents.map((agent) => ({
        agent,
        pins: agents.find((a) => a.id === agent.id)?.pins ?? [],
      })),
    [agents, focusedSubAgents]
  );

  const {
    mediaFiles,
    visibleMediaFiles,
    subAgentMedia,
    mediaOwnerId,
    setMediaOwnerId,
    animatingMediaKeys,
    unseenMediaCount,
    lightboxIndex,
    lightboxTotalItems,
    lightboxItem,
    setLightboxIndex,
    openLightbox,
    mediaViewportRef,
    refreshMedia,
  } = useMedia(focusedAgentId, mediaPanelOpen, focusedSubAgents);

  const unreadMessageCount = useAgentUnreadCount(focusedAgentId);
  // No Chat view, no unread badge: a terminal session's feed is never read.
  const chatUnreadCountRaw = useAgentChatUnread(focusedAgentId).unread;
  const chatUnreadCount = chatEnabled ? chatUnreadCountRaw : 0;
  const markMessagesRead = useMarkMessagesRead(focusedAgentId);

  // Closed-sidebar external signal for #2019: reuses the same surfaces query
  // and seen-state atom the tab strip itself reads (see SurfaceTabRow), so a
  // new agent-authored decision/input surface is visible from the header
  // toggle without opening the sidebar first.
  const { surfaces: agentSurfaces } = useAgentSurfaces(focusedAgentId);
  const { isNew: isSurfaceNew } = useSurfaceSeen(focusedAgentId);
  const unseenSurfaceCount = agentSurfaces.filter((surface) =>
    isSurfaceNew(surface.id)
  ).length;

  // Only mark read when the sidebar is actually open on the Messages tab.
  // MediaSidebarContent stays mounted while closed and the active tab is
  // persisted per-agent, so gating on the tab alone would silently clear
  // unread state for agents whose last-used tab was Messages.
  useEffect(() => {
    if (mediaPanelOpen && mediaActiveTab === "messages") markMessagesRead();
  }, [mediaPanelOpen, mediaActiveTab, markMessagesRead]);

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

  const changesVisible =
    (isSplit &&
      (splitState.left === "changes" || splitState.right === "changes")) ||
    (!isSplit && changesMatch);

  const { diffStats: focusedDiffStats } = useVisibleDiffStats(
    focusedAgentId ?? "",
    !!focusedAgentId,
    changesVisible
  );

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
    await uploadAgentMedia(agentId, file);
  }, []);

  const handleNavigateToFile = useCallback(
    (filePath: string, lineStart: number | null, feedbackItemId?: number) => {
      if (!focusedAgentId) return;
      const params = new URLSearchParams();
      params.set("file", filePath);
      if (lineStart != null) params.set("line", String(lineStart));
      if (feedbackItemId != null) {
        params.set("feedback", String(feedbackItemId));
      }
      navTo(`/agents/${focusedAgentId}/changes?${params.toString()}`, {
        replace: true,
      });
      if (isMobile) setMobileMediaOpen(false);
    },
    [focusedAgentId, isMobile, navTo, setMobileMediaOpen]
  );

  /**
   * Show one review: the Reviews sidebar, opened on that review. Reached
   * from the Changes tab after submitting one, and from a review card in
   * the Chat feed.
   */
  const handleOpenReview = useCallback(
    (reviewId: number) => {
      if (!focusedAgentId) return;
      navTo(`/agents/${focusedAgentId}?expandReview=${reviewId}`, {
        replace: true,
      });
      setMediaOpen(true);
      setMediaActiveTab("reviews");
    },
    [focusedAgentId, navTo, setMediaOpen, setMediaActiveTab]
  );

  const handleOpenSubmittedReview = useCallback(
    (reviewer: Agent) => {
      if (!reviewer.parentAgentId || reviewer.submittedReviewId == null) return;
      navTo(
        `/agents/${reviewer.parentAgentId}?expandReview=${reviewer.submittedReviewId}`
      );
      setExpandedAgentId(reviewer.parentAgentId);
      setMediaOpen(true);
      setMediaActiveTab("reviews");
      if (isMobile) setMobileLeftOpen(false);
    },
    [
      isMobile,
      navTo,
      setExpandedAgentId,
      setMediaActiveTab,
      setMediaOpen,
      setMobileLeftOpen,
    ]
  );

  useExpandedAgentSync(
    agents,
    validatedSelectedAgentId,
    expandedAgentId,
    setExpandedAgentId
  );

  useEffect(() => {
    pendingAutoAttachAgentIdRef.current = routeAgentId ?? null;
  }, [routeAgentId]);

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

  const {
    attachToAgent,
    startAgent,
    stopAgent,
    deleteAgent,
    handleAgentCreated,
    detachAndClearSelection,
  } = useAgentActions({
    connectedAgentId,
    routeAgentId,
    setExpandedAgentId,
    setCreateOpen,
    setRequestedCreateType,
    setLastUsedAgentType,
    ensureTerminalConnected,
    detachTerminal,
    refreshMedia,
  });

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

  const {
    paletteOpen,
    setPaletteOpen,
    paletteActions,
    paletteGroups,
    launchTemplate,
    setLaunchTemplateId,
  } = useAgentHotkeys({
    agents,
    isMobile,
    sidebarAgentId,
    validatedSelectedAgentId,
    canFocusTerminal: terminalMode === "tmux" && !!focusedAgentId,
    focusTerminal,
    mediaOpen,
    setMediaOpen,
    leftPanelOpen,
    handleSetLeftPanelOpen,
    openCreateDialog,
  });

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

  const handleCreateOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setRequestedCreateType(null);
    }
    setCreateOpen(open);
  }, []);

  const isAttached = connState === "connected" && Boolean(connectedAgentId);
  const hasActiveAgent = Boolean(validatedSelectedAgentId);

  const terminalElement = (
    <TerminalPane
      isAttached={isAttached}
      connState={connState}
      statusMessage={statusMessage}
      terminalMode={terminalMode}
      terminalPlaceholderMessage={terminalPlaceholderMessage}
      terminalHostRef={terminalHostRef}
      resyncing={resyncing}
      draggingFiles={draggingFiles}
      uploadingFiles={uploadingFiles}
      archivePhase={
        selectedAgent?.status === "archiving"
          ? selectedAgent.archivePhase
          : null
      }
      holdBadgeAgentId={focusedAgentId}
      terminalInputAtRef={terminalInputAtRef}
    />
  );

  const changesElement = changesVisible ? (
    <ChangesTab
      agentId={focusedAgentId}
      active={true}
      isMobile={isMobile}
      onReviewSubmitted={handleOpenReview}
    />
  ) : null;

  const whiteboardVisible =
    (isSplit &&
      (splitState.left === "whiteboard" ||
        splitState.right === "whiteboard")) ||
    (!isSplit && whiteboardMatch);
  const whiteboardElement = whiteboardVisible ? (
    <WhiteboardPane agentId={focusedAgentId} active={true} />
  ) : null;

  // The Agent pane's Chat | Console choice, remembered per agent. Flipping
  // to the Console hands it focus once it has been unhidden: the focus is
  // deferred a tick, and a flip back (or an unmount) before it lands drops
  // it, so the Chat composer's own focus is never stolen.
  const [agentView, setAgentViewRaw] = useAgentPaneView(focusedAgentId);
  const consoleFocusTimerRef = useRef<number | null>(null);
  const cancelConsoleFocus = useCallback(() => {
    if (consoleFocusTimerRef.current === null) return;
    window.clearTimeout(consoleFocusTimerRef.current);
    consoleFocusTimerRef.current = null;
  }, []);
  useEffect(() => cancelConsoleFocus, [cancelConsoleFocus]);
  const setAgentView = useCallback(
    (view: AgentPaneView) => {
      setAgentViewRaw(view);
      cancelConsoleFocus();
      if (view === "console") {
        consoleFocusTimerRef.current = window.setTimeout(() => {
          consoleFocusTimerRef.current = null;
          focusTerminal();
        }, 0);
      }
    },
    [cancelConsoleFocus, focusTerminal, setAgentViewRaw]
  );
  const agentPaneVisible = !isSplit
    ? centerTabResolved && !changesMatch && !whiteboardMatch
    : splitState.left === "agent" || splitState.right === "agent";
  const agentPaneProps = {
    agentId: focusedAgentId,
    agent: focusedAgent,
    terminalMode,
    chatEnabled,
    view: agentView,
    onViewChange: setAgentView,
    chatUnreadCount,
    showChildAgents,
    onShowChildAgentsChange: setShowChildAgents,
    childAgentIds: focusedSubAgentIds,
    openLightbox,
    onOpenReview: handleOpenReview,
    isMobile,
  };
  // Only in a split: the single-pane Agent pane is always rendered (hidden
  // under Changes/Whiteboard) so the terminal slot keeps its DOM identity —
  // see AgentPane.
  const splitAgentElement =
    isSplit && agentPaneVisible ? (
      <AgentPane
        {...agentPaneProps}
        active={true}
        terminalSlotRef={splitTerminalSlotRef}
        header={false}
      />
    ) : null;
  const splitAgentHeaderAccessory =
    isSplit && agentPaneVisible && chatEnabled ? (
      <AgentViewToggle
        view={agentView}
        onViewChange={setAgentView}
        chatUnreadCount={chatUnreadCount}
        showChildAgents={showChildAgents}
        onShowChildAgentsChange={setShowChildAgents}
      />
    ) : null;

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
              openSubmittedReview={handleOpenSubmittedReview}
              connectedAgentId={connectedAgentId}
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
              "grid h-full min-h-0 min-w-0",
              isMobile
                ? "grid-rows-[minmax(0,1fr)_auto]"
                : "grid-rows-[minmax(0,1fr)]"
            )}
          >
            <div className="relative flex h-full min-h-0 min-w-0 flex-col">
              <AgentsViewHeader
                isMobile={isMobile}
                connState={connState}
                leftPanelOpen={leftPanelOpen}
                handleSetLeftPanelOpen={handleSetLeftPanelOpen}
                focusedAgentId={focusedAgentId}
                focusedAgentName={focusedAgent?.name ?? null}
                hasActiveAgent={hasActiveAgent}
                focusTerminal={focusTerminal}
                focusedDiffStats={focusedDiffStats}
                activeTab={activeTab}
                centerTabResolved={centerTabResolved}
                chatEnabled={chatEnabled}
                chatUnreadCount={chatUnreadCount}
                isSplit={isSplit}
                splitState={splitState}
                exitSplit={exitSplit}
                onTabChange={onTabChange}
                whiteboardAgentDrew={whiteboardAgentDrew}
                mediaPanelOpen={mediaPanelOpen}
                setMediaOpen={setMediaOpen}
                unseenMediaCount={unseenMediaCount}
                unreadMessageCount={unreadMessageCount}
                unseenSurfaceCount={unseenSurfaceCount}
              />
              <div
                className={cn(
                  "relative min-h-0 flex-1",
                  !isMobile && !bottomBarCollapsed && "pb-14"
                )}
                onDragOver={handleContentDragOver}
                onDragLeave={handleContentDragLeave}
                onDrop={handleContentDrop}
              >
                {isSplit ? (
                  <CenterPaneSplit
                    splitState={splitState}
                    splitLeftRef={splitLeftRef}
                    splitButtonRef={splitButtonRef}
                    splitTerminalSlotRef={splitTerminalSlotRef}
                    changesElement={changesElement}
                    whiteboardElement={whiteboardElement}
                    agentElement={splitAgentElement}
                    agentHeaderAccessory={splitAgentHeaderAccessory}
                    isMobile={isMobile}
                    onLayoutChange={handleSplitLayoutChange}
                    onExitSplit={exitSplit}
                  />
                ) : (
                  <>
                    <div
                      className={cn("h-full", !agentPaneVisible && "hidden")}
                    >
                      <AgentPane
                        {...agentPaneProps}
                        active={agentPaneVisible}
                        terminalSlotRef={defaultTerminalSlotRef}
                        header={true}
                      />
                    </div>
                    <Routes>
                      <Route path="changes" element={changesElement} />
                    </Routes>
                    {whiteboardElement}
                  </>
                )}
                {stableTerminalContainer && terminalArmed
                  ? createPortal(terminalElement, stableTerminalContainer)
                  : null}
                <SplitDropZones
                  visible={isDraggingTab && !isMobile}
                  onDrop={handleDropOnZone}
                />
                {!isMobile ? <BottomBar /> : null}
              </div>

              {!isMobile ? (
                <div
                  className={cn(
                    "pointer-events-none absolute inset-x-2 z-20",
                    bottomBarCollapsed ? "bottom-8" : "bottom-16"
                  )}
                >
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

            {isMobile &&
            (!chatEnabled ||
              (activeTab === "agent" && agentView === "console")) ? (
              <MobileTerminalToolbar
                agentId={connectedAgentId}
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
            mediaFiles={visibleMediaFiles}
            selectedAgentId={focusedAgentId}
            selectedAgentName={focusedAgent?.name ?? null}
            selectedAgentWorkspaceRoot={
              focusedAgent?.worktreePath ?? focusedAgent?.cwd ?? null
            }
            selectedAgentPins={focusedAgent?.pins ?? []}
            selectedAgentIsRunning={focusedAgent?.status === "running"}
            subAgentPins={focusedSubAgentPins}
            subAgentMedia={subAgentMedia}
            ownMediaFiles={mediaFiles}
            mediaOwnerId={mediaOwnerId}
            onMediaOwnerChange={setMediaOwnerId}
            animatingMediaKeys={animatingMediaKeys}
            unseenMediaCount={unseenMediaCount}
            unreadMessageCount={unreadMessageCount}
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
            onNavigateToFile={handleNavigateToFile}
          />
        </div>
      </div>

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
            mediaFiles={visibleMediaFiles}
            selectedAgentId={focusedAgentId}
            selectedAgentName={focusedAgent?.name ?? null}
            selectedAgentWorkspaceRoot={
              focusedAgent?.worktreePath ?? focusedAgent?.cwd ?? null
            }
            selectedAgentPins={focusedAgent?.pins ?? []}
            selectedAgentIsRunning={focusedAgent?.status === "running"}
            subAgentPins={focusedSubAgentPins}
            subAgentMedia={subAgentMedia}
            ownMediaFiles={mediaFiles}
            mediaOwnerId={mediaOwnerId}
            onMediaOwnerChange={setMediaOwnerId}
            onShortcutRun={() => setMobileMediaOpen(false)}
            animatingMediaKeys={animatingMediaKeys}
            unseenMediaCount={unseenMediaCount}
            unreadMessageCount={unreadMessageCount}
            mediaViewportRef={mediaViewportRef}
            activeTab={mediaActiveTab}
            setActiveTab={setMediaActiveTab}
            isSidebarVisible={mobileMediaOpen}
            hasStream={focusedAgentHasStream}
            streamUrl={focusedAgentStreamUrl}
            openLightbox={openLightbox}
            onRequestClose={() => setMobileMediaOpen(false)}
            onUploadFile={uploadFile}
            onNavigateToFile={handleNavigateToFile}
          />
        </GlassSidebar>
      ) : null}

      <AgentsViewDialogs
        paletteOpen={paletteOpen}
        setPaletteOpen={setPaletteOpen}
        paletteActions={paletteActions}
        paletteGroups={paletteGroups}
        launchTemplate={launchTemplate}
        setLaunchTemplateId={setLaunchTemplateId}
        enabledAgentTypes={enabledAgentTypes}
        createOpen={createOpen}
        initialAgentType={requestedCreateType ?? lastUsedAgentType}
        onCreateOpenChange={handleCreateOpenChange}
        resolveCreateDefaultCwd={resolveCreateDefaultCwd}
        onAgentCreated={handleAgentCreated}
        deleteConfirmOpen={deleteConfirmOpen}
        deleteTarget={deleteTarget}
        agents={agents}
        setDeleteConfirmOpen={setDeleteConfirmOpen}
        setDeleteTarget={setDeleteTarget}
        onDelete={deleteAgent}
        stopConfirmOpen={stopConfirmOpen}
        stopTarget={stopTarget}
        setStopConfirmOpen={setStopConfirmOpen}
        setStopTarget={setStopTarget}
        onStop={stopAgent}
        lightboxItem={lightboxItem}
        lightboxIndex={lightboxIndex}
        mediaFileCount={lightboxTotalItems}
        setLightboxIndex={setLightboxIndex}
      />

      <div className="sr-only" aria-live="polite">
        {statusMessage}
      </div>
    </div>
  );
}
