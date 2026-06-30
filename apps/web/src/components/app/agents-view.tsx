import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Routes, Route, useParams } from "react-router-dom";
import { PanelLeftOpen, PanelRightOpen } from "lucide-react";

import { ChangesTab } from "@/components/app/changes-tab";
import { ChangesSettingsPopover } from "@/components/app/changes-settings-popover";
import { CenterPaneTabBar } from "@/components/app/center-pane-tab-bar";
import { useAgentDiffStats } from "@/hooks/use-agent-diff-stats";

import { AgentListContent } from "@/components/app/agent-sidebar";
import {
  agentProjectRoot,
  EXPANDED_AGENT_ID_KEY,
  isFullAccessEnabled,
  readExpandedAgentId,
  readLastUsedAgentType,
} from "@/components/app/agents-view-utils";
import { CreateAgentDialog } from "@/components/app/create-agent-dialog";
import { DeleteAgentDialog } from "@/components/app/delete-agent-dialog";
import {
  DesktopFeedbackDetail,
  MobileFeedbackDetail,
} from "@/components/app/agents-view-feedback-detail";
import { MediaLightbox } from "@/components/app/media-lightbox";
import {
  MediaSidebar,
  MediaSidebarContent,
} from "@/components/app/media-sidebar";
import { TerminalCopyModeBannerLayer } from "@/components/app/terminal-copy-mode-banner";
import { MobileTerminalToolbar } from "@/components/app/mobile-terminal-toolbar";
import { SidebarShell, type NavSection } from "@/components/app/sidebar-shell";
import { StopAgentDialog } from "@/components/app/stop-agent-dialog";
import { QuickPhrasesButton } from "@/components/app/quick-phrases";
import { TerminalPane } from "@/components/app/terminal-pane";
import { AmbientTipBar } from "@/components/tips/ambient-tip-bar";
import { TipSpot } from "@/components/tips/tip-spot";
import {
  type Agent,
  type AgentVisualState,
  type ConnState,
} from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { GlassSidebar } from "@/components/ui/glass-sidebar";
import { uploadAgentMedia } from "@/lib/media-upload";
import { type AgentType, isCliAgentType } from "@/lib/agent-types";
import { type IdeType } from "@/lib/ide-types";
import { cn } from "@/lib/utils";
import { useAgentActions } from "@/hooks/use-agent-actions";
import { useAgents } from "@/hooks/use-agents";
import { useMedia } from "@/hooks/use-media";
import { useMediaSidebarState } from "@/hooks/use-media-sidebar-state";
import { useTerminal } from "@/hooks/use-terminal";
import { useAgentFocus } from "@/hooks/use-agent-focus";
import { useAgentsViewRouting } from "@/hooks/use-agents-view-routing";
import { LaunchTemplateDialog } from "@/components/app/automations-launch-dialog";
import { CommandPalette } from "@/components/app/command-palette";
import { useAgentHotkeys } from "@/hooks/use-agent-hotkeys";

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

  const {
    changesMatch,
    feedbackDetail,
    feedbackDetailRendered,
    handleFeedbackTransitionEnd,
    closeFeedbackDetail,
    openFeedbackDetail,
    navigateFeedbackItem,
    onTabChange,
  } = useAgentsViewRouting({
    routeAgentId,
    agents,
    agentsLoaded,
    validatedSelectedAgentId,
  });

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

  const { diffStats: focusedDiffStats } = useAgentDiffStats(
    focusedAgentId ?? "",
    !!focusedAgentId
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
    return (
      (selected?.persona ? selected.parentAgentId : null) ??
      validatedSelectedAgentId
    );
  }, [agents, validatedSelectedAgentId]);
  const prevSelectedExpansionTargetRef = useRef<string | null>(null);

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

  const toggleAgentDetails = useCallback((agentId: string) => {
    setExpandedAgentId((current) => (current === agentId ? null : agentId));
  }, []);

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
            onTransitionEnd={handleFeedbackTransitionEnd}
          >
            <div className="relative flex h-full min-h-0 min-w-0 flex-col">
              <div className="relative z-10 flex h-14 shrink-0 items-center bg-background px-3">
                <div className="flex items-center gap-1">
                  {!leftPanelOpen ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => handleSetLeftPanelOpen(true)}
                      title="Open sidebar"
                    >
                      <PanelRightOpen className="h-4 w-4" />
                    </Button>
                  ) : null}
                  <TipSpot tipId="quick-phrases" side="bottom" align="center">
                    <QuickPhrasesButton
                      agentId={
                        hasActiveAgent && connState === "connected"
                          ? focusedAgentId!
                          : null
                      }
                      focusTerminal={focusTerminal}
                    />
                  </TipSpot>
                </div>
                <div className="flex flex-1 items-center justify-center">
                  {focusedAgent?.name ? (
                    <>
                      <span
                        data-testid="current-session-name"
                        className="sr-only"
                      >
                        {focusedAgent.name}
                      </span>
                      <CenterPaneTabBar
                        activeTab={changesMatch ? "changes" : "terminal"}
                        onTabChange={onTabChange}
                        diffStats={focusedDiffStats}
                      />
                    </>
                  ) : null}
                </div>
                <div className="flex items-center gap-1">
                  {changesMatch && !isMobile ? (
                    <ChangesSettingsPopover />
                  ) : null}
                  {hasActiveAgent && (!mediaPanelOpen || isMobile) ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="relative"
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
                  ) : null}
                </div>
                {connState === "reconnecting" ? (
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
                    <div className="dispatch-reconnect-scan h-full w-1/3 will-change-transform bg-[linear-gradient(to_right,transparent,hsl(var(--status-blocked)),hsl(var(--status-waiting)),hsl(var(--status-working)),hsl(var(--status-done)),transparent)] saturate-[1.35] brightness-[1.05] animate-[reconnect-scan_1350ms_ease-in-out_infinite] motion-reduce:animate-none motion-reduce:translate-x-[140%]" />
                  </div>
                ) : null}
              </div>
              <div
                className={cn("relative min-h-0 flex-1", !isMobile && "pb-14")}
              >
                <div className={cn("h-full", changesMatch && "hidden")}>
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
                  />
                </div>
                <Routes>
                  <Route
                    path="changes"
                    element={
                      <ChangesTab
                        agentId={focusedAgentId}
                        active={true}
                        isMobile={isMobile}
                      />
                    }
                  />
                </Routes>
                {!isMobile ? (
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-14 bg-background">
                    <AmbientTipBar />
                  </div>
                ) : null}
              </div>

              {!isMobile ? (
                <div className="pointer-events-none absolute inset-x-2 bottom-16 z-20">
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
                  <DesktopFeedbackDetail
                    detail={feedbackDetailRendered}
                    agents={agents}
                    connectedAgentId={connectedAgentId}
                    sendTerminalInput={sendTerminalInput}
                    onClose={closeFeedbackDetail}
                    onNavigateItem={navigateFeedbackItem}
                  />
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
            selectedAgentRepoRoot={
              focusedAgent?.gitContext?.repoRoot ?? focusedAgent?.cwd ?? null
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
        <MobileFeedbackDetail
          detail={feedbackDetail}
          agents={agents}
          connectedAgentId={connectedAgentId}
          sendTerminalInput={sendTerminalInput}
          onClose={closeFeedbackDetail}
          onNavigateItem={navigateFeedbackItem}
        />
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
            selectedAgentRepoRoot={
              focusedAgent?.gitContext?.repoRoot ?? focusedAgent?.cwd ?? null
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

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        actions={paletteActions}
        groups={paletteGroups}
      />

      {launchTemplate ? (
        <LaunchTemplateDialog
          template={launchTemplate}
          open={!!launchTemplate}
          onOpenChange={(open) => {
            if (!open) setLaunchTemplateId(null);
          }}
          agentTypes={enabledAgentTypes.filter(isCliAgentType)}
        />
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
