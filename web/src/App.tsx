import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { AgentSidebar, AgentSidebarContent } from "@/components/app/agent-sidebar";
import { AppHeader } from "@/components/app/app-header";
import { DocsPane } from "@/components/app/docs-pane";
import { LoginPage } from "@/components/app/login-page";
import { SettingsPane } from "@/components/app/settings-pane";
import { CreateAgentDialog } from "@/components/app/create-agent-dialog";
import { DeleteAgentDialog } from "@/components/app/delete-agent-dialog";
import { MediaLightbox } from "@/components/app/media-lightbox";
import { MediaSidebar, MediaSidebarContent } from "@/components/app/media-sidebar";
import { MobileTerminalToolbar } from "@/components/app/mobile-terminal-toolbar";
import { StatusFooter } from "@/components/app/status-footer";
import { TerminalPane } from "@/components/app/terminal-pane";
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
import { useTheme } from "@/hooks/use-theme";

const CODEX_FULL_ACCESS_ARG = "--dangerously-bypass-approvals-and-sandbox";
const CLAUDE_FULL_ACCESS_ARG = "--dangerously-skip-permissions";
const LAST_USED_CWD_KEY = "dispatch:lastUsedAgentCwd";
const CWD_HISTORY_KEY = "dispatch:cwdHistory";
const CWD_HISTORY_MAX = 20;

function readLastUsedCwd(): string {
  if (typeof window === "undefined") return "";
  const stored = window.localStorage.getItem(LAST_USED_CWD_KEY)?.trim();
  return stored && stored.length > 0 ? stored : "~/";
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

function isFullAccessEnabled(agent: Pick<Agent, "fullAccess" | "agentArgs">): boolean {
  return (
    agent.fullAccess ||
    agent.agentArgs.includes(CODEX_FULL_ACCESS_ARG) ||
    agent.agentArgs.includes(CLAUDE_FULL_ACCESS_ARG)
  );
}

export function App(): JSX.Element {
  // ── Theme ─────────────────────────────────────────────────────────────
  const { theme, setTheme } = useTheme();

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
  const [createType, setCreateType] = useState("codex");
  const [createFullAccess, setCreateFullAccess] = useState(false);
  const [creating, setCreating] = useState(false);
  const [cwdHistory, setCwdHistory] = useState<string[]>(() => readCwdHistory());

  // ── Delete dialog state ───────────────────────────────────────────────
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Agent | null>(null);

  // ── Panes ─────────────────────────────────────────────────────────────
  const [settingsPaneOpen, setSettingsPaneOpen] = useState(false);
  const [docsPaneOpen, setDocsPaneOpen] = useState(false);

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
  } = useMedia(selectedAgentId, mediaPanelOpen);

  const selectedAgentHasStream = selectedAgentId ? streamingAgentIds.has(selectedAgentId) : false;
  const selectedAgentStreamUrl = selectedAgentId ? `/api/v1/agents/${selectedAgentId}/stream` : null;

  // ── Terminal ──────────────────────────────────────────────────────────
  const onAgentSelected = useCallback(
    (agentId: string) => {
      setSelectedAgentId(agentId);
    },
    [setSelectedAgentId]
  );

  const {
    connState,
    connectedAgentId,
    terminalMode,
    terminalPlaceholderMessage,
    statusMessage,
    terminalHostRef,
    ctrlPendingRef,
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

  // Re-sort agents when connected agent changes.
  useEffect(() => {
    resortAgents();
  }, [connectedAgentId, resortAgents]);

  const connectedAgentIdRef = useRef<string | null>(null);
  connectedAgentIdRef.current = connectedAgentId;

  // ── SSE ───────────────────────────────────────────────────────────────
  useSSE(authState, connectedAgentIdRef, selectedAgentIdRef, setStreamingAgentIds, markSeenInCache);

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
    const lastUsedCwd = selectedAgent?.cwd?.trim() || connectedAgent?.cwd?.trim();
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

  // ── Derived values ────────────────────────────────────────────────────
  const isAttached = connState === "connected" && Boolean(connectedAgentId);
  const canAttachSelected = Boolean(selectedAgent && selectedAgent.status === "running" && !isAttached);
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
    if (selectedAgent) return `Ready to attach to session ${selectedAgent.name}`;
    return "Select an agent to open a session.";
  }, [apiState, connectedAgent, connState, selectedAgent]);

  // ── Agent action callbacks ────────────────────────────────────────────
  const resolveCreateDefaultCwd = useCallback((): string => {
    const activeCwd = selectedAgent?.cwd?.trim() || connectedAgent?.cwd?.trim();
    if (activeCwd) return activeCwd;
    const latestAgentCwd = agents[0]?.cwd?.trim();
    if (latestAgentCwd) return latestAgentCwd;
    return readLastUsedCwd();
  }, [agents, connectedAgent, selectedAgent]);

  const openCreateDialog = useCallback(() => {
    setCreateCwd(resolveCreateDefaultCwd());
    setCreateOpen(true);
  }, [resolveCreateDefaultCwd]);

  const toggleAgentDetails = useCallback(
    (agentId: string) => {
      const nextId = selectedAgentId === agentId ? null : agentId;
      setSelectedAgentId(nextId);
      refreshMedia(nextId);
    },
    [refreshMedia, selectedAgentId, setSelectedAgentId]
  );

  const attachToAgent = useCallback(
    async (agent: Agent) => {
      setSelectedAgentId(agent.id);
      refreshMedia(agent.id);
      await ensureTerminalConnected(true, true, agent.id);
    },
    [ensureTerminalConnected, refreshMedia, setSelectedAgentId]
  );

  const startAgent = useCallback(
    async (agent: Agent) => {
      setSelectedAgentId(agent.id);
      await api(`/api/v1/agents/${agent.id}/start`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      refreshMedia(agent.id);
      await ensureTerminalConnected(true, true, agent.id);
    },
    [ensureTerminalConnected, refreshMedia, setSelectedAgentId]
  );

  const stopAgent = useCallback(
    async (agent: Agent) => {
      if (connectedAgentId === agent.id) {
        detachTerminal();
      }
      await api(`/api/v1/agents/${agent.id}/stop`, {
        method: "POST",
        body: JSON.stringify({ force: true }),
      });
    },
    [connectedAgentId, detachTerminal]
  );

  const deleteAgent = useCallback(
    async (agent: Agent) => {
      if (agent.status === "running") {
        await api(`/api/v1/agents/${agent.id}/stop`, {
          method: "POST",
          body: JSON.stringify({ force: true }),
        });
      }
      await api(`/api/v1/agents/${agent.id}`, { method: "DELETE" });
    },
    []
  );

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
          }),
        });

        setCreateOpen(false);
        setCreateName("");
        setCreateFullAccess(false);
        window.localStorage.setItem(LAST_USED_CWD_KEY, createCwd.trim());
        setCwdHistory(addToCwdHistory(payload.agent.cwd));
        setSelectedAgentId(payload.agent.id);
        refreshMedia(payload.agent.id);
        await ensureTerminalConnected(true, true, payload.agent.id);
      } finally {
        setCreating(false);
      }
    },
    [createCwd, createFullAccess, createName, createType, ensureTerminalConnected, refreshMedia, setSelectedAgentId]
  );

  const attachSelectedAgent = useCallback(() => {
    if (!selectedAgent || selectedAgent.status !== "running") return;
    void attachToAgent(selectedAgent);
  }, [attachToAgent, selectedAgent]);

  const borderForAgentState = (state: AgentVisualState): string => {
    if (state === "active") return "border-r-status-working";
    if (state === "idle") return "border-r-status-done";
    return "border-r-status-idle";
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
              overflowAgentId={overflowAgentId}
              setLeftOpen={setLeftOpen}
              onOpenCreateDialog={openCreateDialog}
              onOpenDocs={() => setDocsPaneOpen(true)}
              onOpenSettings={() => setSettingsPaneOpen(true)}
              setOverflowAgentId={setOverflowAgentId}
              setDeleteTarget={setDeleteTarget}
              setDeleteConfirmOpen={setDeleteConfirmOpen}
              agentVisualState={agentVisualState}
              borderForAgentState={borderForAgentState}
              toggleAgentDetails={toggleAgentDetails}
              isFullAccessEnabled={isFullAccessEnabled}
              detachTerminal={detachTerminal}
              attachToAgent={attachToAgent}
              stopAgent={stopAgent}
              startAgent={startAgent}
            />
          </div>
        ) : null}

        <main
          className={cn("min-h-0 min-w-0 flex-1 overflow-hidden", mediaOpen && !isMobile && "border-r-2 border-border")}
        >
          <div
            className={cn(
              "grid h-full min-h-0 min-w-0",
              isMobile ? "grid-rows-[auto_1fr_auto_auto]" : "grid-rows-[auto_1fr_auto]"
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
              canAttachSelected={canAttachSelected}
              unseenMediaCount={unseenMediaCount}
              setLeftOpen={handleSetLeftPanelOpen}
              setMediaOpen={handleSetMediaPanelOpen}
              attachSelectedAgent={attachSelectedAgent}
              detachTerminal={detachTerminal}
            />

            <TerminalPane
              isAttached={isAttached}
              hasSelectedAgent={Boolean(selectedAgentId)}
              connState={connState}
              statusMessage={statusMessage}
              terminalMode={terminalMode}
              terminalPlaceholderMessage={terminalPlaceholderMessage}
              terminalHostRef={terminalHostRef}
            />

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
            selectedAgentId={selectedAgentId}
            selectedAgentName={selectedAgent?.name ?? null}
            animatingMediaKeys={animatingMediaKeys}

            mediaViewportRef={mediaViewportRef}
            setMediaOpen={setMediaOpen}
            hasStream={selectedAgentHasStream}
            streamUrl={selectedAgentStreamUrl}
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
            overflowAgentId={overflowAgentId}
            onOpenCreateDialog={() => { setMobileLeftOpen(false); openCreateDialog(); }}
            onOpenDocs={() => { setMobileLeftOpen(false); setDocsPaneOpen(true); }}
            onOpenSettings={() => { setMobileLeftOpen(false); setSettingsPaneOpen(true); }}
            setOverflowAgentId={setOverflowAgentId}
            setDeleteTarget={setDeleteTarget}
            setDeleteConfirmOpen={(open) => { if (open) setMobileLeftOpen(false); setDeleteConfirmOpen(open); }}
            agentVisualState={agentVisualState}
            borderForAgentState={borderForAgentState}
            toggleAgentDetails={toggleAgentDetails}
            isFullAccessEnabled={isFullAccessEnabled}
            detachTerminal={detachTerminal}
            attachToAgent={attachToAgent}
            stopAgent={stopAgent}
            startAgent={startAgent}
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
              selectedAgentId={selectedAgentId}
              selectedAgentName={selectedAgent?.name ?? null}
              animatingMediaKeys={animatingMediaKeys}
  
              mediaViewportRef={mediaViewportRef}
              hasStream={selectedAgentHasStream}
              streamUrl={selectedAgentStreamUrl}
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
        creating={creating}
        cwdHistory={cwdHistory}
        setOpen={setCreateOpen}
        setCreateName={setCreateName}
        setCreateType={setCreateType}
        setCreateCwd={setCreateCwd}
        setCreateFullAccess={setCreateFullAccess}
        onSubmit={handleCreateAgent}
      />

      <DeleteAgentDialog
        open={deleteConfirmOpen}
        deleteTarget={deleteTarget}
        setOpen={setDeleteConfirmOpen}
        setDeleteTarget={setDeleteTarget}
        onDelete={deleteAgent}
      />

      <DocsPane open={docsPaneOpen} onClose={() => setDocsPaneOpen(false)} />
      <SettingsPane open={settingsPaneOpen} onClose={() => setSettingsPaneOpen(false)} onLogout={handleLogout} theme={theme} setTheme={setTheme} />

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
