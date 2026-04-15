import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAtom } from "jotai";
import "@xterm/xterm/css/xterm.css";
import { BarChart3, History, PanelLeftOpen, PanelRightOpen } from "lucide-react";
import { feedbackDetailAtom, expandedAgentIdAtom, fullAccessByCwdAtom, baseBranchByCwdAtom, autoReviewByCwdAtom } from "@/lib/store";
import { AgentListContent } from "@/components/app/agent-sidebar";
import { ActivityPane } from "@/components/app/activity-pane";
import { JobsProvider, JobListContent, JobDetailPane } from "@/components/app/jobs-pane";
import { SettingsContent, SettingsNavContent, useSettingsState } from "@/components/app/settings-pane";
import { type NavSection, SidebarShell } from "@/components/app/sidebar-shell";
import { CreateAgentDialog } from "@/components/app/create-agent-dialog";
import { DeleteAgentDialog } from "@/components/app/delete-agent-dialog";
import { StopAgentDialog } from "@/components/app/stop-agent-dialog";
import { MediaLightbox } from "@/components/app/media-lightbox";
import { MediaSidebar, MediaSidebarContent } from "@/components/app/media-sidebar";
import { MobileTerminalToolbar } from "@/components/app/mobile-terminal-toolbar";
import { TerminalPane } from "@/components/app/terminal-pane";
import { type FeedbackDetailState, FeedbackDetailPanel, ReviewSummaryPanel } from "@/components/app/feedback-panel";
import {
  type Agent,
  type AgentVisualState,
  type ServiceState,
} from "@/components/app/types";
import { GlassSidebar } from "@/components/ui/glass-sidebar";
import { cn } from "@/lib/utils";
import { initEnergyMetrics } from "@/lib/energy-metrics";
import { api } from "@/lib/api";
import { useAuthContext } from "@/contexts/auth-context";
import { useHealth } from "@/hooks/use-health";
import { useLayout } from "@/hooks/use-layout";
import { useAgents } from "@/hooks/use-agents";
import { useSSE } from "@/hooks/use-sse";
import { useMedia } from "@/hooks/use-media";
import { useTerminal } from "@/hooks/use-terminal";
import { useIconColor } from "@/hooks/use-icon-color";
import { useInstanceName } from "@/hooks/use-instance-name";
import { useTheme } from "@/hooks/use-theme";
import { useAgentFocus } from "@/hooks/use-agent-focus";
import { useTemporaryState } from "@/hooks/use-temporary-state";
import { AGENT_TYPES, type AgentType, isAgentType, sanitizeEnabledAgentTypes } from "@/lib/agent-types";
import { Button } from "@/components/ui/button";

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

export function DashboardLayout(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();

  // ── Route matching ───────────────────────────────────────────────────
  const pathSegments = location.pathname.split("/").filter(Boolean);
  const legacyDocsOpen = pathSegments[0] === "docs";
  const legacyDocsSection = legacyDocsOpen ? pathSegments[1] : undefined;
  const settingsOpen = pathSegments[0] === "settings";
  const settingsSection = settingsOpen ? pathSegments[1] : undefined;
  const settingsSubsection = settingsOpen ? pathSegments[2] : undefined;
  const activityOpen = pathSegments[0] === "activity";
  const activityTab = activityOpen ? (pathSegments[1] as "metrics" | "history" | undefined) : undefined;
  const jobsOpen = pathSegments[0] === "jobs";

  useEffect(() => {
    if (!legacyDocsOpen) return;
    navigate(legacyDocsSection ? `/settings/help/${legacyDocsSection}` : "/settings/help", { replace: true });
  }, [legacyDocsOpen, legacyDocsSection, navigate]);

  // ── Theme & Branding ──────────────────────────────────────────────────
  const { theme, setTheme } = useTheme();
  const { iconColor, setIconColor, isLoading: isIconColorSaving, error: iconColorError, clearError: clearIconColorError } = useIconColor();
  const { instanceName } = useInstanceName();

  // ── Page title ───────────────────────────────────────────────────────
  useEffect(() => {
    document.title = instanceName ? `${instanceName} — Dispatch` : "Dispatch";
  }, [instanceName]);

  // ── Auth (from context — AuthLayout guarantees authenticated) ─────────
  const { handleLogout } = useAuthContext();

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
  const { apiState, dbState } = useHealth(true);

  // ── Media ─────────────────────────────────────────────────────────────
  const selectedAgentIdRef = useRef<string | null>(null);

  // ── Create dialog state ───────────────────────────────────────────────
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createCwd, setCreateCwd] = useState(() => readLastUsedCwd());
  const [createCwdInitialized, setCreateCwdInitialized] = useState(() => readLastUsedCwd().trim().length > 0);
  const [enabledAgentTypes, setEnabledAgentTypes] = useState<AgentType[]>([...AGENT_TYPES]);
  const [lastUsedAgentType, setLastUsedAgentType] = useState<AgentType | null>(() => readLastUsedAgentType());
  const [createType, setCreateType] = useState<AgentType>("codex");
  const [createFullAccess, setCreateFullAccess] = useAtom(fullAccessByCwdAtom(createCwd));
  const [createAutoReview, setCreateAutoReview] = useAtom(autoReviewByCwdAtom(createCwd));
  const [createBaseBranch, setCreateBaseBranch] = useAtom(baseBranchByCwdAtom(createCwd));
  const [createUseWorktree, setCreateUseWorktree] = useState(true);
  const [createWorktreeBranch, setCreateWorktreeBranch] = useState("");
  const [createInitialPrompt, setCreateInitialPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [cwdHistory, setCwdHistory] = useState<string[]>(() => readCwdHistory());

  // ── Delete dialog state ───────────────────────────────────────────────
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Agent | null>(null);
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [stopTarget, setStopTarget] = useState<Agent | null>(null);

  // ── Misc UI state ────────────────────────────────────────────────────
  const [feedbackDetail, setFeedbackDetail] = useAtom(feedbackDetailAtom);
  // Keep last feedback detail alive during close transition so content fades out.
  const feedbackDetailStaleRef = useRef<NonNullable<FeedbackDetailState> | null>(null);
  if (feedbackDetail) feedbackDetailStaleRef.current = feedbackDetail;
  const feedbackDetailRendered = feedbackDetail ?? feedbackDetailStaleRef.current;
  const [expandedAgentId, setExpandedAgentId] = useAtom(expandedAgentIdAtom);

  // ── Agent selection ────────────────────────────────────────────────────
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  // ── Agents ────────────────────────────────────────────────────────────
  const [sharedConnectedAgentId, setSharedConnectedAgentId] = useState<string | null>(null);
  const [sharedConnState, setSharedConnState] = useState<"disconnected" | "reconnecting" | "connected">("disconnected");

  const {
    agents,
    agentsLoaded,
    selectedAgent,
    connectedAgent,
    overflowAgentId,
    setOverflowAgentId,
    streamingAgentIds,
    setStreamingAgentIds,
    agentVisualState,
    resortAgents,
    validatedSelectedAgentId,
  } = useAgents(sharedConnectedAgentId, sharedConnState, true, selectedAgentId);

  selectedAgentIdRef.current = validatedSelectedAgentId;

  const focusedAgentId = sharedConnState === "connected" || sharedConnState === "reconnecting"
    ? (sharedConnectedAgentId ?? validatedSelectedAgentId)
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
      const body = await res.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? `Upload failed (${res.status})`);
    }
  }, []);

  const ensureAuxExpanded = useCallback((agentId: string) => {
    setExpandedAgentId(agentId);
  }, [setExpandedAgentId]);

  // ── Terminal ──────────────────────────────────────────────────────────
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
    authState: "authenticated",
    agents,
    agentsLoaded,
    selectedAgentId: validatedSelectedAgentId,
    theme,
    isMobile,
    leftOpen,
    mediaOpen,
    feedbackOpen: !!feedbackDetail,
    setSelectedAgentId,
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

  // ── Focus tracking (notification suppression) ─────────────────────────
  useAgentFocus(focusedAgentId, "authenticated");

  // ── SSE ───────────────────────────────────────────────────────────────
  useSSE("authenticated", connectedAgentIdRef, selectedAgentIdRef, setStreamingAgentIds, markSeenInCache);

  // Return focus to the terminal when either sidebar closes.
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
  const hasActiveAgent = Boolean(validatedSelectedAgentId);
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
    [setExpandedAgentId]
  );

  const attachToAgent = useCallback(
    async (agent: Agent) => {
      setSelectedAgentId(agent.id);
      // Child persona agents are rendered inside their parent's expanded card,
      // so expand the parent instead of the child to keep it visible.
      ensureAuxExpanded(agent.parentAgentId ?? agent.id);
      refreshMedia(agent.id);
      await ensureTerminalConnected(true, true, agent.id);
    },
    [ensureAuxExpanded, ensureTerminalConnected, refreshMedia]
  );

  const startAgent = useCallback(
    async (agent: Agent) => {
      setSelectedAgentId(agent.id);
      ensureAuxExpanded(agent.parentAgentId ?? agent.id);
      await api(`/api/v1/agents/${agent.id}/start`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      refreshMedia(agent.id);
      await ensureTerminalConnected(true, true, agent.id);
    },
    [ensureAuxExpanded, ensureTerminalConnected, refreshMedia]
  );

  const detachAndClearSelection = useCallback(() => {
    detachTerminal();
    setSelectedAgentId(null);
  }, [detachTerminal]);

  const handleAgentsWorkspaceUnmount = useCallback(() => {
    detachAndClearSelection();
    setFeedbackDetail(null);
  }, [detachAndClearSelection, setFeedbackDetail]);

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
      setExpandedAgentId((current) => current === agent.id ? null : current);
      setFeedbackDetail((prev) => prev?.parentAgentId === agent.id ? null : prev);
      const params = new URLSearchParams();
      if (cleanupWorktree) {
        params.set("cleanupWorktree", cleanupWorktree);
      }
      const qs = params.toString();
      // Backend handles stopping + cleanup asynchronously; returns 202 immediately
      await api(`/api/v1/agents/${agent.id}${qs ? `?${qs}` : ""}`, { method: "DELETE" });
    },
    [connectedAgentId, detachTerminal, setExpandedAgentId, setFeedbackDetail]
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
            autoReview: createAutoReview,
            useWorktree: createUseWorktree,
            worktreeBranch: createWorktreeBranch.trim() || undefined,
            baseBranch: createBaseBranch !== "main" ? createBaseBranch : undefined,
            initialPrompt: createInitialPrompt.trim() || undefined,
          }),
        });

        setCreateOpen(false);
        setCreateName("");
        setCreateUseWorktree(true);
        setCreateWorktreeBranch("");
        setCreateInitialPrompt("");
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
    [createAutoReview, createBaseBranch, createCwd, createFullAccess, createInitialPrompt, createName, createType, createUseWorktree, createWorktreeBranch, ensureAuxExpanded, ensureTerminalConnected, refreshMedia]
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

  const [pulsingNavItem, setPulsingNavItem] = useTemporaryState<string | null>(null, 260);
  const [pendingNavPulse, setPendingNavPulse] = useState<string | null>(null);

  const currentNavItem = (() => {
    if (location.pathname.startsWith("/jobs")) return "jobs";
    if (location.pathname.startsWith("/activity")) return "activity";
    if (location.pathname.startsWith("/settings")) return "settings";
    return "agents";
  })();
  const prevNavItemRef = useRef(currentNavItem);

  useEffect(() => {
    const previousNavItem = prevNavItemRef.current;
    prevNavItemRef.current = currentNavItem;

    if (!isMobile) return;
    if (currentNavItem === previousNavItem) return;

    // When switching sections on mobile, auto-open the sidebar so the nav bar
    // and section content (agent list, job list, settings nav) are accessible.
    // Activity is self-contained (tabs + content in main area), so skip auto-open.
    setMobileMediaOpen(false);
    if (currentNavItem !== "activity") {
      setMobileLeftOpen(true);
    }
  }, [currentNavItem, isMobile, setMobileLeftOpen, setMobileMediaOpen]);

  useEffect(() => {
    if (!pendingNavPulse || pendingNavPulse !== currentNavItem) return;
    setPulsingNavItem(pendingNavPulse);
    setPendingNavPulse(null);
  }, [currentNavItem, pendingNavPulse, setPulsingNavItem]);

  const triggerNavAnimation = useCallback((navItem: string) => {
    if (navItem === currentNavItem) {
      setPulsingNavItem(navItem);
      return;
    }
    setPendingNavPulse(navItem);
  }, [currentNavItem, setPulsingNavItem]);

  // ── Navigation callbacks ────────────────────────────────────────────
  const handleSidebarNavigate = useCallback((section: NavSection) => {
    if (section === "agents") navigate("/");
    else if (section === "jobs") navigate("/jobs");
    else if (section === "activity") navigate("/activity");
    else if (section === "settings") navigate("/settings");
  }, [navigate]);

  // ── Settings state ────────────────────────────────────────────────────
  const { activeSection: settingsActiveSection, setActiveSectionState: setSettingsActiveSection, isAdmin, sections: settingsSections } = useSettingsState(settingsOpen, settingsSection);

  const handleSettingsSectionChange = useCallback((section: string | null) => {
    if (section) {
      setSettingsActiveSection(section as Parameters<typeof setSettingsActiveSection>[0]);
      navigate(`/settings/${section}`, { replace: true });
      if (isMobile) setMobileLeftOpen(false);
    }
  }, [isMobile, navigate, setMobileLeftOpen, setSettingsActiveSection]);

  // ── Sidebar content helper for closing on mobile actions ────────────
  const mobileCloseAndAction = useCallback(<T extends unknown[]>(fn: (...args: T) => void) => {
    return (...args: T) => {
      if (isMobile) setMobileLeftOpen(false);
      fn(...args);
    };
  }, [isMobile, setMobileLeftOpen]);

  const isAgentsView = currentNavItem === "agents";

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <JobsProvider open={jobsOpen} agents={agents} onOpenAgent={attachToAgent} enabledAgentTypes={enabledAgentTypes}>
    <div className="h-full min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex h-full min-h-0 min-w-0 overflow-hidden">
        {/* ── Unified sidebar (desktop: inline, mobile: slide-over) ─── */}
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
            activeSection={currentNavItem as NavSection}
            onNavigate={(section) => {
              handleSidebarNavigate(section);
            }}
            onRequestClose={isMobile ? () => setMobileLeftOpen(false) : () => setLeftOpen(false)}
            closeButtonIcon={isMobile ? "x" : "chevron"}
            pulsingNavItem={pulsingNavItem}
            triggerNavAnimation={triggerNavAnimation}
          >
            {currentNavItem === "agents" && (
              <AgentListContent
                agents={agents}
                selectedAgentId={validatedSelectedAgentId}
                expandedAgentId={expandedAgentId}
                overflowAgentId={overflowAgentId}
                onOpenCreateDialog={isMobile ? mobileCloseAndAction(openCreateDialog) : openCreateDialog}
                enabledAgentTypes={enabledAgentTypes}
                lastUsedAgentType={lastUsedAgentType}
                setOverflowAgentId={setOverflowAgentId}
                setDeleteTarget={setDeleteTarget}
                setDeleteConfirmOpen={isMobile ? mobileCloseAndAction(setDeleteConfirmOpen) : setDeleteConfirmOpen}
                setStopTarget={setStopTarget}
                setStopConfirmOpen={isMobile ? mobileCloseAndAction(setStopConfirmOpen) : setStopConfirmOpen}
                agentVisualState={agentVisualState}
                borderForAgentState={borderForAgentState}
                toggleAgentDetails={toggleAgentDetails}
                isFullAccessEnabled={isFullAccessEnabled}
                detachTerminal={detachAndClearSelection}
                attachToAgent={attachToAgent}
                startAgent={startAgent}
                sendTerminalInput={sendTerminalInput}
                connectedAgentId={connectedAgentId}
                onOpenFeedbackDetail={setFeedbackDetail}
                feedbackDetailState={feedbackDetail}
                onRequestClose={isMobile ? () => setMobileLeftOpen(false) : undefined}
                closeOnSessionAction={isMobile}
              />
            )}
            {currentNavItem === "jobs" && <JobListContent onItemSelect={isMobile ? () => setMobileLeftOpen(false) : undefined} />}
            {currentNavItem === "settings" && (
              <SettingsNavContent
                activeSection={settingsActiveSection}
                activeSubsection={settingsSubsection}
                sections={settingsSections}
                onSectionChange={handleSettingsSectionChange}
                onSubsectionChange={(subsection) => {
                  navigate(`/settings/help/${subsection}`, { replace: true });
                  if (isMobile) setMobileLeftOpen(false);
                }}
                apiState={apiState}
                dbState={dbState}
                serviceDotClass={serviceDotClass}
              />
            )}
            {currentNavItem === "activity" && (
              <div className="flex h-full min-h-0 flex-col">
                <div className="mt-2 flex h-14 items-center border-b border-border px-3">
                  <div className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Activity</div>
                </div>
                <nav className="min-h-0 flex-1 overflow-y-auto py-2">
                  <button
                    type="button"
                    onClick={() => { if (isMobile) setMobileLeftOpen(false); navigate("/activity/metrics", { replace: true }); }}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm transition-colors",
                      (activityTab ?? "metrics") === "metrics"
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <BarChart3 className="h-3.5 w-3.5 shrink-0" />
                    Metrics
                  </button>
                  <button
                    type="button"
                    onClick={() => { if (isMobile) setMobileLeftOpen(false); navigate("/activity/history", { replace: true }); }}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm transition-colors",
                      activityTab === "history"
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <History className="h-3.5 w-3.5 shrink-0" />
                    History
                  </button>
                </nav>
              </div>
            )}
          </SidebarShell>
        </GlassSidebar>

        {/* ── Main content area ──────────────────────────────────────── */}
        <main
          className={cn("min-h-0 min-w-0 flex-1 overflow-hidden", mediaOpen && !isMobile && isAgentsView && "border-r-2 border-border")}
        >
          <div
            className={cn(
              "grid h-full min-h-0 min-w-0 transition-[grid-template-rows] duration-300 ease-in-out",
              !isAgentsView
                ? "grid-rows-[minmax(0,1fr)]"
                : isMobile
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
            {/* Open sidebar button — shown on all views when sidebar is collapsed */}
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

            {/* Agents view — terminal */}
            {isAgentsView && (
              <div className="relative min-h-0 min-w-0 pb-14 pt-14">
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
                      onClick={() => handleSetMediaPanelOpen(true)}
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
                    <div className="dispatch-reconnect-scan h-full w-1/3 bg-gradient-to-r from-transparent via-status-waiting to-transparent" />
                  </div>
                ) : null}
                <AgentsWorkspace onUnmount={handleAgentsWorkspaceUnmount}>
                  <TerminalPane
                    isAttached={isAttached}
                    connState={connState}
                    statusMessage={statusMessage}
                    terminalMode={terminalMode}
                    terminalPlaceholderMessage={terminalPlaceholderMessage}
                    terminalHostRef={terminalHostRef}
                    archivePhase={selectedAgent?.status === "archiving" ? selectedAgent.archivePhase : null}
                  />
                </AgentsWorkspace>
              </div>
            )}

            {/* Jobs view */}
            {jobsOpen && (
              <div className={cn("min-h-0 min-w-0", !leftPanelOpen && "pt-14")}>
                <JobDetailPane />
              </div>
            )}

            {/* Activity view */}
            {activityOpen && (
              <div className={cn("min-h-0 min-w-0 flex-1 overflow-hidden", !leftPanelOpen && "pt-14")}>
                <ActivityPane
                  open={true}
                  initialTab={activityTab}
                />
              </div>
            )}

            {/* Settings view */}
            {settingsOpen && (
              <div className={cn("min-h-0 min-w-0 flex-1 overflow-hidden", !leftPanelOpen && "pt-14")}>
              <SettingsContent
                activeSection={settingsActiveSection}
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
                initialSubsection={settingsSubsection}
                onSubsectionChange={(subsection) => {
                  if (settingsSection !== "help") return;
                  navigate(subsection ? `/settings/help/${subsection}` : "/settings/help", { replace: true });
                }}
                isAdmin={isAdmin}
              />
              </div>
            )}

            {/* Feedback panel — agents view only */}
            {!isMobile && isAgentsView ? (
              <div className={cn("min-h-0 overflow-hidden transition-opacity duration-300", feedbackDetail ? "opacity-100" : "opacity-0")}>
                {feedbackDetailRendered ? (
                  "summaryAgentId" in feedbackDetailRendered ? (
                    (() => {
                      const summaryAgent = agents.find((a) => a.id === feedbackDetailRendered.summaryAgentId);
                      return summaryAgent ? (
                        <ReviewSummaryPanel
                          key={`summary-${feedbackDetailRendered.summaryAgentId}`}
                          parentAgentId={feedbackDetailRendered.parentAgentId}
                          agent={summaryAgent}
                          onClose={() => setFeedbackDetail(null)}
                        />
                      ) : null;
                    })()
                  ) : (
                    <FeedbackDetailPanel
                      key={feedbackDetailRendered.parentAgentId}
                      parentAgentId={feedbackDetailRendered.parentAgentId}
                      itemId={feedbackDetailRendered.itemId}
                      isConnected={connectedAgentId === feedbackDetailRendered.parentAgentId}
                      sendTerminalInput={sendTerminalInput}
                      onClose={() => setFeedbackDetail(null)}
                      onNavigate={(itemId) => setFeedbackDetail((prev) => prev ? { ...prev, itemId } : null)}
                    />
                  )
                ) : null}
              </div>
            ) : null}

            {isMobile && isAgentsView ? <MobileTerminalToolbar onSendInput={sendTerminalInput} ctrlPendingRef={ctrlPendingRef} /> : null}
          </div>
        </main>

        {/* ── Media sidebar (right, desktop only, agents view only) ── */}
        {isAgentsView ? (
        <div className="hidden shrink-0 md:block">
          <MediaSidebar
            mediaOpen={mediaOpen && hasActiveAgent}
            mediaFiles={mediaFiles}
            selectedAgentId={focusedAgentId}
            selectedAgentName={focusedAgent?.name ?? null}
            selectedAgentWorkspaceRoot={focusedAgent?.worktreePath ?? focusedAgent?.cwd ?? null}
            selectedAgentPins={focusedAgent?.pins ?? []}
            animatingMediaKeys={animatingMediaKeys}
            unseenMediaCount={unseenMediaCount}
            mediaViewportRef={mediaViewportRef}
            setMediaOpen={setMediaOpen}
            hasStream={focusedAgentHasStream}
            streamUrl={focusedAgentStreamUrl}
            openLightbox={openLightbox}
            onUploadFile={uploadFile}
          />
        </div>
        ) : null}
      </div>

      {/* ── Mobile media slide-over ──────────────────────────────────── */}
      {isMobile && isAgentsView ? (
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
            selectedAgentWorkspaceRoot={focusedAgent?.worktreePath ?? focusedAgent?.cwd ?? null}
            selectedAgentPins={focusedAgent?.pins ?? []}
            animatingMediaKeys={animatingMediaKeys}
            unseenMediaCount={unseenMediaCount}
            mediaViewportRef={mediaViewportRef}
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
        createName={createName}
        createType={createType}
        createCwd={createCwd}
        createFullAccess={createFullAccess}
        createAutoReview={createAutoReview}
        createUseWorktree={createUseWorktree}
        createWorktreeBranch={createWorktreeBranch}
        createBaseBranch={createBaseBranch}
        creating={creating}
        cwdHistory={cwdHistory}
        enabledAgentTypes={enabledAgentTypes}
        initialPrompt={createInitialPrompt}
        setOpen={setCreateOpen}
        setCreateName={setCreateName}
        setCreateType={setCreateType}
        setCreateCwd={setCreateCwd}
        setCreateFullAccess={setCreateFullAccess}
        setCreateAutoReview={setCreateAutoReview}
        setCreateUseWorktree={setCreateUseWorktree}
        setCreateWorktreeBranch={setCreateWorktreeBranch}
        setCreateBaseBranch={setCreateBaseBranch}
        setInitialPrompt={setCreateInitialPrompt}
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
    </JobsProvider>
  );
}

function AgentsWorkspace({
  children,
  onUnmount,
}: {
  children: React.ReactNode;
  onUnmount: () => void;
}): JSX.Element {
  useEffect(() => {
    return () => {
      onUnmount();
    };
  }, [onUnmount]);

  return <>{children}</>;
}
