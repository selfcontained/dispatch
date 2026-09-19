import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Routes, Route, useNavigate, useParams } from "react-router-dom";
import { useAtom, useAtomValue } from "jotai";

import {
  bottomBarCollapsedAtom,
  chatShowChildAgentsAtom,
  type CenterTab,
} from "@/lib/store";

import { AgentPane, ChatFiltersButton } from "@/components/app/agent-pane";
import { ChangesTab } from "@/components/app/changes-tab";
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
import { SidebarShell, type NavSection } from "@/components/app/sidebar-shell";
import { type Agent, type AgentVisualState } from "@/components/app/types";
import { GlassSidebar } from "@/components/ui/glass-sidebar";
import { uploadAgentMedia } from "@/lib/media-upload";
import { type AgentType } from "@/lib/agent-types";
import { type IdeType } from "@/lib/ide-types";
import { cn } from "@/lib/utils";
import { useAgentActions } from "@/hooks/use-agent-actions";
import { useAgents } from "@/hooks/use-agents";
import { useAgentChatUnread } from "@/hooks/use-chat-unread-summary";
import { useMedia } from "@/hooks/use-media";
import { useStreamRail } from "@/hooks/use-stream-rail";
import { THREAD_PARAM } from "@/lib/agent-routes";
import { useMediaSidebarState } from "@/hooks/use-media-sidebar-state";
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
  const { agentId: routeAgentId } = useParams();
  const navTo = useNavigate();

  const [showChildAgents, setShowChildAgents] = useAtom(
    chatShowChildAgentsAtom
  );

  const {
    agents,
    agentsLoaded,
    validatedSelectedAgentId,
    selectedAgent,
    overflowAgentId,
    setOverflowAgentId,
    agentVisualState,
  } = useAgents(true, routeAgentId ?? null);

  const { changesMatch, centerTabResolved, onTabChange } = useAgentsViewRouting(
    {
      routeAgentId,
      agentsLoaded,
      validatedSelectedAgentId,
    }
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

  const { expandedAgentId, setExpandedAgentId, toggleAgentDetails } =
    useExpandedAgent();

  const sidebarAgentId = validatedSelectedAgentId;
  const agentIds = useMemo(() => agents.map((a) => a.id), [agents]);
  const {
    mediaOpen,
    mediaPanelOpen,
    mediaActiveTab,
    mediaPinned,
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

  const focusedAgentId = validatedSelectedAgentId;
  const focusedAgent = focusedAgentId
    ? (agents.find((agent) => agent.id === focusedAgentId) ?? null)
    : null;
  const activeTab: CenterTab = changesMatch ? "changes" : "agent";

  const bottomBarCollapsed = useAtomValue(bottomBarCollapsedAtom);

  const {
    splitState,
    isSplit,
    exitSplit,
    isDraggingTab,
    splitLeftRef,
    splitButtonRef,
    handleContentDragOver,
    handleContentDragLeave,
    handleContentDrop,
    handleDropOnZone,
    handleSplitLayoutChange,
  } = useCenterPaneLayout({
    focusedAgentId,
    isMobile,
    activeTab,
  });

  // The focused agent's direct children, whose media the sidebar groups
  // under it. Direct children only — the same family the server's
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
  const {
    mediaFiles,
    visibleMediaFiles,
    subAgentMedia,
    mediaOwnerId,
    setMediaOwnerId,
    animatingMediaKeys,
    unseenMediaCount,
    lightboxMediaId,
    lightboxMediaIds,
    setLightboxMediaId,
    openLightbox,
    mediaViewportRef,
    refreshMedia,
  } = useMedia(focusedAgentId, mediaPanelOpen, focusedSubAgents);

  const chatUnreadCount = useAgentChatUnread(focusedAgentId).unread;

  // The rail: open questions and forms, derived from the stream feed the
  // Chat tab holds. Its count shows on the closed sidebar's toggle so an
  // agent waiting on the user is visible without opening the sidebar.
  const rail = useStreamRail(focusedAgentId);
  const railDisabledReason =
    focusedAgent && focusedAgent.status !== "running"
      ? "The agent is not running. Start it to answer."
      : null;
  const agentNameById = useCallback(
    (agentId: string) =>
      agents.find((agent) => agent.id === agentId)?.name ?? "Agent",
    [agents]
  );

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

  const uploadFile = useCallback(async (agentId: string, file: File) => {
    await uploadAgentMedia(agentId, file);
  }, []);

  /** Opens the Changes tab on a file, at a line when one is given. */
  const handleOpenPath = useCallback(
    (filePath: string, line: number | null) => {
      if (!focusedAgentId) return;
      const params = new URLSearchParams();
      params.set("file", filePath);
      if (line != null) params.set("line", String(line));
      navTo(`/agents/${focusedAgentId}/changes?${params.toString()}`, {
        replace: true,
      });
      if (isMobile) setMobileMediaOpen(false);
    },
    [focusedAgentId, isMobile, navTo, setMobileMediaOpen]
  );

  /** Opens a block's thread in the Chat tab; from the rail. */
  const handleOpenBlock = useCallback(
    (blockId: string) => {
      if (!focusedAgentId) return;
      navTo(`/agents/${focusedAgentId}?${THREAD_PARAM}=${blockId}`);
      if (isMobile) setMobileMediaOpen(false);
    },
    [focusedAgentId, isMobile, navTo, setMobileMediaOpen]
  );

  /** After a review is posted from the Changes tab, show it in the Chat. */
  const handleReviewPosted = useCallback(
    (blockId: string) => {
      if (!focusedAgentId) return;
      navTo(`/agents/${focusedAgentId}?${THREAD_PARAM}=${blockId}`, {
        replace: true,
      });
    },
    [focusedAgentId, navTo]
  );

  useExpandedAgentSync(
    agents,
    validatedSelectedAgentId,
    expandedAgentId,
    setExpandedAgentId
  );

  const {
    attachToAgent,
    startAgent,
    stopAgent,
    deleteAgent,
    handleAgentCreated,
    detachAndClearSelection,
  } = useAgentActions({
    routeAgentId,
    setExpandedAgentId,
    setCreateOpen,
    setRequestedCreateType,
    setLastUsedAgentType,
    refreshMedia,
  });

  const resolveCreateDefaultCwd = useCallback((): string => {
    const activeCwd = agentProjectRoot(selectedAgent);
    if (activeCwd) return activeCwd;
    const latestAgentCwd = agentProjectRoot(agents[0]);
    if (latestAgentCwd) return latestAgentCwd;
    return "";
  }, [agents, selectedAgent]);

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

  const hasActiveAgent = Boolean(validatedSelectedAgentId);

  const changesElement = changesVisible ? (
    <ChangesTab
      agentId={focusedAgentId}
      agent={focusedAgent}
      enabledAgentTypes={enabledAgentTypes}
      active={true}
      isMobile={isMobile}
      onReviewPosted={handleReviewPosted}
    />
  ) : null;

  const agentPaneVisible = !isSplit
    ? centerTabResolved && !changesMatch
    : splitState.left === "agent" || splitState.right === "agent";
  const agentPaneProps = {
    agentId: focusedAgentId,
    agent: focusedAgent,
    showChildAgents,
    onShowChildAgentsChange: setShowChildAgents,
    openLightbox,
    onOpenPath: handleOpenPath,
    isMobile,
  };
  // Only in a split: the single-pane Agent pane is always rendered (hidden
  // under Changes) so its draft and scroll position survive a tab
  // switch.
  const splitAgentElement =
    isSplit && agentPaneVisible ? (
      <AgentPane {...agentPaneProps} active={true} header={false} />
    ) : null;
  const splitAgentHeaderAccessory =
    isSplit && agentPaneVisible ? (
      <ChatFiltersButton
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
              connectedAgentId={validatedSelectedAgentId}
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
                leftPanelOpen={leftPanelOpen}
                handleSetLeftPanelOpen={handleSetLeftPanelOpen}
                focusedAgentId={focusedAgentId}
                focusedAgentName={focusedAgent?.name ?? null}
                hasActiveAgent={hasActiveAgent}
                focusedDiffStats={focusedDiffStats}
                activeTab={activeTab}
                centerTabResolved={centerTabResolved}
                chatUnreadCount={chatUnreadCount}
                isSplit={isSplit}
                splitState={splitState}
                exitSplit={exitSplit}
                onTabChange={onTabChange}
                mediaPanelOpen={mediaPanelOpen}
                setMediaOpen={setMediaOpen}
                unseenMediaCount={unseenMediaCount}
                openInputCount={rail.inputs.length}
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
                    changesElement={changesElement}
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
                        header={true}
                      />
                    </div>
                    <Routes>
                      <Route path="changes" element={changesElement} />
                    </Routes>
                  </>
                )}
                <SplitDropZones
                  visible={isDraggingTab && !isMobile}
                  onDrop={handleDropOnZone}
                />
                {!isMobile ? <BottomBar /> : null}
              </div>
            </div>
          </div>
        </main>

        <div className="hidden shrink-0 md:block">
          <MediaSidebar
            mediaOpen={mediaOpen && hasActiveAgent}
            mediaFiles={visibleMediaFiles}
            selectedAgentId={focusedAgentId}
            selectedAgentName={focusedAgent?.name ?? null}
            subAgentMedia={subAgentMedia}
            ownMediaFiles={mediaFiles}
            mediaOwnerId={mediaOwnerId}
            onMediaOwnerChange={setMediaOwnerId}
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
            rail={rail}
            railDisabledReason={railDisabledReason}
            agentNameById={agentNameById}
            onOpenBlock={handleOpenBlock}
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
            subAgentMedia={subAgentMedia}
            ownMediaFiles={mediaFiles}
            mediaOwnerId={mediaOwnerId}
            onMediaOwnerChange={setMediaOwnerId}
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
            rail={rail}
            railDisabledReason={railDisabledReason}
            agentNameById={agentNameById}
            onOpenBlock={handleOpenBlock}
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
        lightboxMediaId={lightboxMediaId}
        lightboxMediaIds={lightboxMediaIds}
        setLightboxMediaId={setLightboxMediaId}
      />
    </div>
  );
}
