import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal as XTerm } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import { AgentSidebar, AgentSidebarContent } from "@/components/app/agent-sidebar";
import { AppHeader } from "@/components/app/app-header";
import { CreateAgentDialog } from "@/components/app/create-agent-dialog";
import { DeleteAgentDialog } from "@/components/app/delete-agent-dialog";
import { EditWorktreeModeDialog } from "@/components/app/edit-worktree-mode-dialog";
import { MediaLightbox } from "@/components/app/media-lightbox";
import { MediaSidebar, MediaSidebarContent } from "@/components/app/media-sidebar";
import { StatusFooter } from "@/components/app/status-footer";
import { TerminalPane } from "@/components/app/terminal-pane";
import {
  type Agent,
  type AgentVisualState,
  type ConnState,
  type MediaFile,
  type ServiceState,
  type WorktreeMode
} from "@/components/app/types";
import { MobileSlidePanel } from "@/components/ui/mobile-slide-panel";
import { cn } from "@/lib/utils";

const DEFAULT_CWD = "/Users/bharris/dev/apps/dispatch";
const FULL_ACCESS_ARG = "--dangerously-bypass-approvals-and-sandbox";
const LEFT_SIDEBAR_KEY = "dispatch:leftSidebarOpen";
const LEFT_SIDEBAR_LEGACY_KEY = "hostess:leftSidebarOpen";
const MEDIA_SIDEBAR_KEY = "dispatch:mediaSidebarOpen";
const MEDIA_SIDEBAR_LEGACY_KEY = "hostess:mediaSidebarOpen";
const LAST_USED_CWD_KEY = "dispatch:lastUsedAgentCwd";
const ACTIVE_SHELL_AGENT_KEY = "dispatch:activeShellAgentId";
const DEFAULT_WORKTREE_MODE: WorktreeMode = "ask";
// Chrome Device Toolbar can emulate mobile with a wider layout viewport in some modes.
// Treat coarse/non-hover input as mobile as well so drawer behavior stays consistent.
const MOBILE_BREAKPOINT_QUERY = "(max-width: 767px), (pointer: coarse), (hover: none)";

function readLastUsedCwd(): string {
  if (typeof window === "undefined") {
    return DEFAULT_CWD;
  }
  const stored = window.localStorage.getItem(LAST_USED_CWD_KEY)?.trim();
  return stored && stored.length > 0 ? stored : DEFAULT_CWD;
}

function readActiveShellAgentId(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const stored = window.localStorage.getItem(ACTIVE_SHELL_AGENT_KEY)?.trim();
  return stored && stored.length > 0 ? stored : null;
}

function persistActiveShellAgentId(agentId: string | null): void {
  if (typeof window === "undefined") {
    return;
  }
  if (agentId) {
    window.localStorage.setItem(ACTIVE_SHELL_AGENT_KEY, agentId);
    return;
  }
  window.localStorage.removeItem(ACTIVE_SHELL_AGENT_KEY);
}

type UiEvent =
  | { type: "snapshot"; agents: Agent[] }
  | { type: "agent.upsert"; agent: Agent }
  | { type: "agent.deleted"; agentId: string }
  | { type: "media.changed"; agentId: string }
  | { type: "media.seen"; agentId: string; keys: string[] };

function sortAgentsByCreatedAtDesc(items: Agent[]): Agent[] {
  const eventPriority = (agent: Agent): number => {
    if (agent.latestEvent?.type === "blocked") {
      return 0;
    }
    if (agent.latestEvent?.type === "waiting_user") {
      return 1;
    }
    return 2;
  };

  const latestActivityAt = (agent: Agent): string => {
    return agent.latestEvent?.updatedAt ?? agent.updatedAt ?? agent.createdAt;
  };

  return [...items].sort((a, b) => {
    const priorityDelta = eventPriority(a) - eventPriority(b);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return latestActivityAt(b).localeCompare(latestActivityAt(a));
  });
}

function isFullAccessEnabled(agent: Pick<Agent, "codexArgs">): boolean {
  return agent.codexArgs.includes(FULL_ACCESS_ARG);
}

export function App(): JSX.Element {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [restoreShellAgentId, setRestoreShellAgentId] = useState<string | null>(() => readActiveShellAgentId());
  const [agentsLoaded, setAgentsLoaded] = useState(false);

  const [connState, setConnState] = useState<ConnState>("disconnected");
  const [connectedAgentId, setConnectedAgentId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("Starting...");

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createCwd, setCreateCwd] = useState(() => readLastUsedCwd());
  const [createType, setCreateType] = useState("codex");
  const [createFullAccess, setCreateFullAccess] = useState(false);
  const [createWorktreeMode, setCreateWorktreeMode] = useState<WorktreeMode>(DEFAULT_WORKTREE_MODE);
  const [createWorktreeRepoRoot, setCreateWorktreeRepoRoot] = useState<string | null>(null);
  const [createWorktreeLoading, setCreateWorktreeLoading] = useState(false);
  const [createWorktreeSaving, setCreateWorktreeSaving] = useState(false);
  const [createWorktreeError, setCreateWorktreeError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Agent | null>(null);
  const [editWorktreeOpen, setEditWorktreeOpen] = useState(false);
  const [editWorktreeTarget, setEditWorktreeTarget] = useState<Agent | null>(null);
  const [editWorktreeMode, setEditWorktreeMode] = useState<WorktreeMode>("off");
  const [editWorktreeLoading, setEditWorktreeLoading] = useState(false);
  const [editWorktreeSaving, setEditWorktreeSaving] = useState(false);
  const [editWorktreeError, setEditWorktreeError] = useState<string | null>(null);

  const [leftOpen, setLeftOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return true;
    }
    const stored =
      window.localStorage.getItem(LEFT_SIDEBAR_KEY) ??
      window.localStorage.getItem(LEFT_SIDEBAR_LEGACY_KEY);
    return stored === null ? true : stored === "true";
  });
  const [mediaOpen, setMediaOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return false;
    }
    const stored =
      window.localStorage.getItem(MEDIA_SIDEBAR_KEY) ??
      window.localStorage.getItem(MEDIA_SIDEBAR_LEGACY_KEY);
    return stored === null ? false : stored === "true";
  });
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches;
  });
  const [mobileLeftOpen, setMobileLeftOpen] = useState(false);
  const [mobileMediaOpen, setMobileMediaOpen] = useState(false);
  const leftPanelOpen = isMobile ? mobileLeftOpen : leftOpen;
  const mediaPanelOpen = isMobile ? mobileMediaOpen : mediaOpen;
  const [overflowAgentId, setOverflowAgentId] = useState<string | null>(null);
  const [selectedAgentWorktreeMode, setSelectedAgentWorktreeMode] = useState<WorktreeMode | null>(null);
  const [selectedAgentWorktreeLoading, setSelectedAgentWorktreeLoading] = useState(false);

  const [mediaFiles, setMediaFiles] = useState<MediaFile[]>([]);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [lightboxCaption, setLightboxCaption] = useState("");
  const [seenMediaKeys, setSeenMediaKeys] = useState<Set<string>>(new Set());
  const [animatingMediaKeys, setAnimatingMediaKeys] = useState<Set<string>>(new Set());

  const [apiState, setApiState] = useState<ServiceState>("checking");
  const [dbState, setDbState] = useState<ServiceState>("checking");
  const [mediaState, setMediaState] = useState<ServiceState>("checking");

  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const mediaViewportRef = useRef<HTMLDivElement>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const selectedAgentIdRef = useRef<string | null>(null);
  const shouldKeepAttachedRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const attachNonceRef = useRef(0);
  const healthPollTimerRef = useRef<number | null>(null);
  const clearMediaAnimTimerRef = useRef<number | null>(null);
  const previousMediaKeysRef = useRef<Set<string>>(new Set());

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId]
  );

  const connectedAgent = useMemo(
    () => agents.find((agent) => agent.id === connectedAgentId) ?? null,
    [agents, connectedAgentId]
  );

  const resolveCreateDefaultCwd = useCallback((): string => {
    const activeCwd = selectedAgent?.cwd?.trim() || connectedAgent?.cwd?.trim();
    if (activeCwd) {
      return activeCwd;
    }

    const latestAgentCwd = agents[0]?.cwd?.trim();
    if (latestAgentCwd) {
      return latestAgentCwd;
    }

    return readLastUsedCwd();
  }, [agents, connectedAgent, selectedAgent]);

  const openCreateDialog = useCallback(() => {
    setCreateCwd(resolveCreateDefaultCwd());
    setCreateOpen(true);
  }, [resolveCreateDefaultCwd]);

  const openEditWorktreeDialog = useCallback((agent: Agent) => {
    setEditWorktreeTarget(agent);
    setEditWorktreeMode("off");
    setEditWorktreeError(null);
    setEditWorktreeOpen(true);
  }, []);

  const api = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const hasBody = init?.body !== undefined && init?.body !== null;
    const res = await fetch(path, {
      headers: {
        ...(hasBody ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {})
      },
      ...init
    });

    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const payload = (await res.json()) as { error?: string };
        if (payload.error) {
          message = payload.error;
        }
      } catch {}
      throw new Error(message);
    }

    if (res.status === 204) {
      return null as T;
    }

    return (await res.json()) as T;
  }, []);

  const refreshAgents = useCallback(async () => {
    const payload = await api<{ agents: Agent[] }>("/api/v1/agents");
    setAgents(sortAgentsByCreatedAtDesc(payload.agents));

    setSelectedAgentId((current) => {
      if (current && payload.agents.some((agent) => agent.id === current)) {
        return current;
      }
      return null;
    });
  }, [api]);

  const refreshMedia = useCallback(
    async (agentId?: string | null) => {
      const id = agentId ?? selectedAgentId;
      if (!id) {
        setMediaFiles([]);
        setSeenMediaKeys(new Set());
        setMediaState("checking");
        return;
      }

      try {
        const payload = await api<{ files: MediaFile[] }>(`/api/v1/agents/${id}/media`);
        const files = payload.files ?? [];
        setMediaFiles(files);
        setSeenMediaKeys(
          new Set(
            files
              .filter((file) => file.seen === true)
              .map((file) => `${file.name}:${file.updatedAt}`)
          )
        );
        setMediaState("ok");
      } catch {
        setMediaFiles([]);
        setSeenMediaKeys(new Set());
        setMediaState("down");
      }
    },
    [api, selectedAgentId]
  );

  const markMediaSeen = useCallback(
    async (agentId: string, keys: string[]) => {
      if (keys.length === 0) {
        return;
      }

      try {
        await api<{ ok: boolean; updated: number }>(`/api/v1/agents/${agentId}/media/seen`, {
          method: "POST",
          body: JSON.stringify({ keys })
        });
      } catch {}
    },
    [api]
  );

  const pollHealth = useCallback(async () => {
    try {
      const health = await api<{ status: string; db: string }>("/api/v1/health");
      setApiState(health.status === "ok" ? "ok" : "down");
      setDbState(health.db === "ok" ? "ok" : "down");
    } catch {
      setApiState("down");
      setDbState("down");
    }
  }, [api]);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const closeSocket = useCallback((announce = true) => {
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
      setConnectedAgentId(null);
    }

    if (announce) {
      setStatusMessage("Session disconnected.");
      setConnState("disconnected");
    }
  }, []);

  const sendResize = useCallback(() => {
    const ws = wsRef.current;
    const term = terminalRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !term) {
      return;
    }

    ws.send(
      JSON.stringify({
        type: "resize",
        cols: term.cols,
        rows: term.rows
      })
    );
  }, []);

  const ensureTerminalConnected = useCallback(
    async (clearScreen = false, userInitiated = false, targetAgentId?: string) => {
      if (userInitiated) {
        shouldKeepAttachedRef.current = true;
      }

      const resolvedAgentId = targetAgentId ?? selectedAgentId;
      if (!shouldKeepAttachedRef.current || !resolvedAgentId) {
        return;
      }

      let agent = agents.find((item) => item.id === resolvedAgentId) ?? null;
      if (!agent || agent.status !== "running") {
        const payload = await api<{ agent: Agent }>(
          `/api/v1/agents/${resolvedAgentId}?includeGitContext=false`
        );
        agent = payload.agent;
      }

      if (agent.status !== "running") {
        setConnState("disconnected");
        return;
      }

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        if (connectedAgentId === agent.id) {
          sendResize();
          return;
        }
      }

      clearReconnectTimer();
      closeSocket(false);

      if (clearScreen) {
        terminalRef.current?.clear();
      }

      fitAddonRef.current?.fit();
      const attachNonce = ++attachNonceRef.current;
      setConnState("reconnecting");
      setStatusMessage(`Connecting to session ${agent.name}...`);
      const scheduleReconnect = (message: string) => {
        if (!shouldKeepAttachedRef.current || attachNonce !== attachNonceRef.current) {
          setConnState("disconnected");
          return;
        }

        reconnectAttemptsRef.current += 1;
        const delay = Math.min(1200 * reconnectAttemptsRef.current, 8000);
        setConnState("reconnecting");
        setStatusMessage(message);

        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          void ensureTerminalConnected(false, false, resolvedAgentId);
        }, delay);
      };

      try {
        const token = await api<{ token: string; wsUrl: string }>(
          `/api/v1/agents/${agent.id}/terminal/token`,
          { method: "POST", body: JSON.stringify({}) }
        );

        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const term = terminalRef.current;
        const cols = term?.cols ?? 140;
        const rows = term?.rows ?? 42;
        const ws = new WebSocket(`${protocol}//${window.location.host}${token.wsUrl}&cols=${cols}&rows=${rows}`);
        wsRef.current = ws;

        ws.addEventListener("open", () => {
          reconnectAttemptsRef.current = 0;
          setConnState("connected");
          setConnectedAgentId(agent.id);
          setStatusMessage(`Connected to session ${agent.name}`);
          terminalRef.current?.focus();
        });

        ws.addEventListener("message", (event) => {
          const payload = JSON.parse(String(event.data)) as
            | { type: "output"; data: string }
            | { type: "error"; message: string }
            | { type: "exit" };

          if (payload.type === "output") {
            terminalRef.current?.write(payload.data);
          } else if (payload.type === "error") {
            const normalized = payload.message.toLowerCase();
            if (
              normalized.includes("session no longer exists") ||
              normalized.includes("attach failed") ||
              normalized.includes("invalid or expired terminal token")
            ) {
              shouldKeepAttachedRef.current = false;
            }
            setStatusMessage(`Session error: ${payload.message}`);
          } else if (payload.type === "exit") {
            setStatusMessage("Session ended.");
          }
        });

        ws.addEventListener("close", (event) => {
          if (wsRef.current !== ws) {
            return;
          }

          wsRef.current = null;

          if (event.code === 1008 || event.code === 1011) {
            shouldKeepAttachedRef.current = false;
            setConnState("disconnected");
            return;
          }

          scheduleReconnect("Session disconnected, reconnecting...");
        });
      } catch {
        scheduleReconnect("Session connection failed, retrying...");
      }
    },
    [
      agents,
      api,
      clearReconnectTimer,
      closeSocket,
      connectedAgentId,
      selectedAgentId,
      sendResize
    ]
  );

  const detachTerminal = useCallback(() => {
    shouldKeepAttachedRef.current = false;
    persistActiveShellAgentId(null);
    setRestoreShellAgentId(null);
    clearReconnectTimer();
    closeSocket(false);
    setConnState("disconnected");
    setStatusMessage("Detached from session.");
  }, [clearReconnectTimer, closeSocket]);

  const toggleAgentDetails = useCallback(
    (agentId: string) => {
      const nextId = selectedAgentId === agentId ? null : agentId;
      setSelectedAgentId(nextId);
      void refreshMedia(nextId);
    },
    [refreshMedia, selectedAgentId]
  );

  const attachToAgent = useCallback(
    async (agent: Agent) => {
      setSelectedAgentId(agent.id);
      void refreshMedia(agent.id);
      await ensureTerminalConnected(true, true, agent.id);
    },
    [ensureTerminalConnected, refreshMedia]
  );

  const startAgent = useCallback(
    async (agent: Agent) => {
      setSelectedAgentId(agent.id);
      await api(`/api/v1/agents/${agent.id}/start`, {
        method: "POST",
        body: JSON.stringify({})
      });
      void refreshMedia(agent.id);
      await ensureTerminalConnected(true, true, agent.id);
      void refreshAgents();
      setStatusMessage(`Started ${agent.name} and attached to session.`);
    },
    [api, ensureTerminalConnected, refreshAgents, refreshMedia]
  );

  const stopAgent = useCallback(
    async (agent: Agent) => {
      if (connectedAgentId === agent.id) {
        detachTerminal();
      }

      await api(`/api/v1/agents/${agent.id}/stop`, {
        method: "POST",
        body: JSON.stringify({ force: true })
      });

      if (selectedAgentId === agent.id) {
        closeSocket(false);
        setConnState("disconnected");
      }

      await refreshAgents();
      await refreshMedia();
      setStatusMessage(`Stopped ${agent.name}.`);
    },
    [api, closeSocket, connectedAgentId, detachTerminal, refreshAgents, refreshMedia, selectedAgentId]
  );

  const deleteAgent = useCallback(
    async (agent: Agent) => {
      if (agent.status === "running") {
        await api(`/api/v1/agents/${agent.id}/stop`, {
          method: "POST",
          body: JSON.stringify({ force: true })
        });
      }

      await api(`/api/v1/agents/${agent.id}`, { method: "DELETE" });
      if (selectedAgentId === agent.id) {
        closeSocket(false);
      }

      await refreshAgents();
      await refreshMedia();
      setStatusMessage(`Deleted ${agent.name}.`);
    },
    [api, closeSocket, refreshAgents, refreshMedia, selectedAgentId]
  );

  const handleCreateAgent = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!createCwd.trim()) {
        return;
      }

      setCreating(true);

      try {
        const payload = await api<{ agent: Agent }>("/api/v1/agents", {
          method: "POST",
          body: JSON.stringify({
            name: createName.trim(),
            cwd: createCwd.trim(),
            type: createType,
            fullAccess: createFullAccess
          })
        });

        setCreateOpen(false);
        setCreateName("");
        setCreateFullAccess(false);
        window.localStorage.setItem(LAST_USED_CWD_KEY, createCwd.trim());
        setSelectedAgentId(payload.agent.id);
        void refreshMedia(payload.agent.id);
        await ensureTerminalConnected(true, true, payload.agent.id);
        void refreshAgents();
        setStatusMessage(`Created ${payload.agent.name} and attached to session.`);
      } finally {
        setCreating(false);
      }
    },
    [api, createCwd, createFullAccess, createName, createType, ensureTerminalConnected, refreshAgents, refreshMedia]
  );

  const refreshCreateWorktreeMode = useCallback(async () => {
    const cwd = createCwd.trim();
    if (!cwd) {
      setCreateWorktreeRepoRoot(null);
      setCreateWorktreeError("Enter a git working directory to load repo defaults.");
      setCreateWorktreeMode(DEFAULT_WORKTREE_MODE);
      return;
    }

    setCreateWorktreeLoading(true);
    setCreateWorktreeError(null);
    try {
      const payload = await api<{
        repoRoot: string;
        config: { worktreeMode: WorktreeMode };
      }>(`/api/v1/repo-config?cwd=${encodeURIComponent(cwd)}`);
      setCreateWorktreeMode(payload.config.worktreeMode);
      setCreateWorktreeRepoRoot(payload.repoRoot);
      setCreateWorktreeError(null);
    } catch {
      setCreateWorktreeRepoRoot(null);
      setCreateWorktreeMode("off");
      setCreateWorktreeError("Using Off (repo settings unavailable).");
    } finally {
      setCreateWorktreeLoading(false);
    }
  }, [api, createCwd]);

  const setAndPersistWorktreeMode = useCallback(
    async (value: WorktreeMode) => {
      setCreateWorktreeMode(value);
      const cwd = createCwd.trim();
      if (!cwd) {
        setCreateWorktreeError("Enter a git working directory before saving.");
        return;
      }

      setCreateWorktreeSaving(true);
      setCreateWorktreeError(null);

      try {
        const payload = await api<{
          repoRoot: string;
          config: { worktreeMode: WorktreeMode };
        }>("/api/v1/repo-config", {
          method: "PATCH",
          body: JSON.stringify({
            cwd,
            worktreeMode: value
          })
        });
        setCreateWorktreeMode(payload.config.worktreeMode);
        setCreateWorktreeRepoRoot(payload.repoRoot);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to save repo config.";
        setCreateWorktreeError(message);
      } finally {
        setCreateWorktreeSaving(false);
      }
    },
    [api, createCwd]
  );

  useEffect(() => {
    const host = terminalHostRef.current;
    if (!host) {
      return;
    }

    const term = new XTerm({
      convertEol: false,
      cursorBlink: true,
      fontFamily: "JetBrains Mono, Menlo, monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: {
        foreground: "#f8f8f2",
        background: "#141414",
        cursor: "#f8f8f0",
        cursorAccent: "#141414",
        selectionBackground: "#49483e",
        selectionInactiveBackground: "#3e3d32",
        black: "#141414",
        red: "#f92672",
        green: "#a6e22e",
        yellow: "#f4bf75",
        blue: "#66d9ef",
        magenta: "#ae81ff",
        cyan: "#a1efe4",
        white: "#f8f8f2",
        brightBlack: "#75715e",
        brightRed: "#f92672",
        brightGreen: "#a6e22e",
        brightYellow: "#f4bf75",
        brightBlue: "#66d9ef",
        brightMagenta: "#ae81ff",
        brightCyan: "#a1efe4",
        brightWhite: "#f9f8f5"
      }
    });

    const fit = new FitAddon();

    terminalRef.current = term;
    fitAddonRef.current = fit;
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    const disposable = term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    const onResize = () => {
      fit.fit();
      sendResize();
    };

    window.addEventListener("resize", onResize);

    return () => {
      disposable.dispose();
      window.removeEventListener("resize", onResize);
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sendResize]);

  useEffect(() => {
    const query = window.matchMedia(MOBILE_BREAKPOINT_QUERY);
    const onChange = () => setIsMobile(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => {
      query.removeEventListener("change", onChange);
    };
  }, []);

  useEffect(() => {
    void (async () => {
      await Promise.all([pollHealth(), refreshAgents()]);
      setAgentsLoaded(true);
      setStatusMessage("Select an agent to open a session.");
    })();
  }, [pollHealth, refreshAgents]);

  useEffect(() => {
    if (!agentsLoaded || !restoreShellAgentId) {
      return;
    }

    const restoreTarget = agents.find((agent) => agent.id === restoreShellAgentId);
    if (!restoreTarget || restoreTarget.status !== "running") {
      persistActiveShellAgentId(null);
      setRestoreShellAgentId(null);
      return;
    }

    setSelectedAgentId(restoreTarget.id);
    void refreshMedia(restoreTarget.id);
    void ensureTerminalConnected(true, true, restoreTarget.id);
    setStatusMessage(`Restored session for ${restoreTarget.name}.`);
    setRestoreShellAgentId(null);
  }, [agents, agentsLoaded, ensureTerminalConnected, refreshMedia, restoreShellAgentId]);

  useEffect(() => {
    void refreshMedia();
  }, [refreshMedia]);

  useEffect(() => {
    if (healthPollTimerRef.current) {
      window.clearInterval(healthPollTimerRef.current);
    }
    healthPollTimerRef.current = window.setInterval(() => {
      void pollHealth();
    }, 8000);

    return () => {
      if (healthPollTimerRef.current) {
        window.clearInterval(healthPollTimerRef.current);
        healthPollTimerRef.current = null;
      }
    };
  }, [pollHealth]);

  useEffect(() => {
    selectedAgentIdRef.current = selectedAgentId;
  }, [selectedAgentId]);

  useEffect(() => {
    const source = new EventSource("/api/v1/events");
    eventSourceRef.current = source;

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as UiEvent;

        if (payload.type === "snapshot") {
          setAgents(sortAgentsByCreatedAtDesc(payload.agents));
          return;
        }

        if (payload.type === "agent.upsert") {
          setAgents((current) => {
            const index = current.findIndex((agent) => agent.id === payload.agent.id);
            if (index === -1) {
              return sortAgentsByCreatedAtDesc([payload.agent, ...current]);
            }
            const next = [...current];
            next[index] = payload.agent;
            return sortAgentsByCreatedAtDesc(next);
          });
          return;
        }

        if (payload.type === "agent.deleted") {
          setAgents((current) => current.filter((agent) => agent.id !== payload.agentId));
          return;
        }

        if (payload.type === "media.changed" && payload.agentId === selectedAgentIdRef.current) {
          void refreshMedia(payload.agentId);
          return;
        }

        if (payload.type === "media.seen" && payload.agentId === selectedAgentIdRef.current) {
          setSeenMediaKeys((current) => {
            const next = new Set(current);
            let changed = false;

            for (const key of payload.keys) {
              if (!next.has(key)) {
                next.add(key);
                changed = true;
              }
            }

            return changed ? next : current;
          });
        }
      } catch {}
    };

    return () => {
      source.close();
      if (eventSourceRef.current === source) {
        eventSourceRef.current = null;
      }
    };
  }, [refreshMedia]);

  useEffect(() => {
    setSelectedAgentId((current) => {
      if (current && agents.some((agent) => agent.id === current)) {
        return current;
      }
      return null;
    });
  }, [agents]);

  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) {
        void ensureTerminalConnected(false, false, connectedAgentId ?? selectedAgentId ?? undefined);
      }
    };

    const onFocus = () => {
      void ensureTerminalConnected(false, false, connectedAgentId ?? selectedAgentId ?? undefined);
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [connectedAgentId, ensureTerminalConnected, selectedAgentId]);

  useEffect(() => {
    if (isMobile) {
      return;
    }
    const fitNow = () => {
      fitAddonRef.current?.fit();
      sendResize();
    };

    fitNow();
    const timer = window.setTimeout(fitNow, 340);
    return () => window.clearTimeout(timer);
  }, [isMobile, leftOpen, mediaOpen, sendResize]);

  useEffect(() => {
    setSeenMediaKeys(new Set());
  }, [selectedAgentId]);

  useEffect(() => {
    const cwd = selectedAgent?.cwd?.trim();
    if (!selectedAgent || !cwd) {
      setSelectedAgentWorktreeMode(null);
      setSelectedAgentWorktreeLoading(false);
      return;
    }

    let active = true;
    setSelectedAgentWorktreeLoading(true);

    void (async () => {
      try {
        const payload = await api<{
          config: { worktreeMode: WorktreeMode };
        }>(`/api/v1/repo-config?cwd=${encodeURIComponent(cwd)}`);
        if (!active) {
          return;
        }
        setSelectedAgentWorktreeMode(payload.config.worktreeMode);
      } catch {
        if (!active) {
          return;
        }
        setSelectedAgentWorktreeMode("off");
      } finally {
        if (active) {
          setSelectedAgentWorktreeLoading(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [api, selectedAgent]);

  useEffect(() => {
    const cwd = editWorktreeTarget?.cwd?.trim();
    if (!editWorktreeOpen || !cwd) {
      setEditWorktreeLoading(false);
      return;
    }

    let active = true;
    setEditWorktreeLoading(true);
    setEditWorktreeError(null);

    void (async () => {
      try {
        const payload = await api<{
          config: { worktreeMode: WorktreeMode };
        }>(`/api/v1/repo-config?cwd=${encodeURIComponent(cwd)}`);
        if (!active) {
          return;
        }
        setEditWorktreeMode(payload.config.worktreeMode);
      } catch {
        if (!active) {
          return;
        }
        setEditWorktreeMode("off");
        setEditWorktreeError("Using Off (repo settings unavailable).");
      } finally {
        if (active) {
          setEditWorktreeLoading(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [api, editWorktreeOpen, editWorktreeTarget]);

  const saveEditWorktreeMode = useCallback(async () => {
    const cwd = editWorktreeTarget?.cwd?.trim();
    if (!editWorktreeTarget || !cwd) {
      return;
    }

    setEditWorktreeSaving(true);
    setEditWorktreeError(null);
    try {
      const payload = await api<{
        config: { worktreeMode: WorktreeMode };
      }>("/api/v1/repo-config", {
        method: "PATCH",
        body: JSON.stringify({
          cwd,
          worktreeMode: editWorktreeMode
        })
      });
      if (selectedAgentId === editWorktreeTarget.id) {
        setSelectedAgentWorktreeMode(payload.config.worktreeMode);
      }
      setEditWorktreeOpen(false);
    } catch {
      setEditWorktreeError("Unable to save worktree mode.");
    } finally {
      setEditWorktreeSaving(false);
    }
  }, [api, editWorktreeMode, editWorktreeTarget, selectedAgentId]);

  useEffect(() => {
    const nextKeys = mediaFiles.map((file) => `${file.name}:${file.updatedAt}`);
    const prevKeys = previousMediaKeysRef.current;

    if (prevKeys.size > 0) {
      const incoming = nextKeys.filter((key) => !prevKeys.has(key));
      if (incoming.length > 0) {
        setAnimatingMediaKeys(new Set(incoming));

        if (clearMediaAnimTimerRef.current) {
          window.clearTimeout(clearMediaAnimTimerRef.current);
        }
        clearMediaAnimTimerRef.current = window.setTimeout(() => {
          setAnimatingMediaKeys(new Set());
          clearMediaAnimTimerRef.current = null;
        }, 2200);
      }
    }

    previousMediaKeysRef.current = new Set(nextKeys);
  }, [mediaFiles]);

  useEffect(() => {
    if (!mediaPanelOpen) {
      return;
    }

    const root = mediaViewportRef.current;
    const selected = selectedAgentId;
    if (!root || !selected) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const newlySeen: string[] = [];
        setSeenMediaKeys((current) => {
          let changed = false;
          const next = new Set(current);

          for (const entry of entries) {
            if (entry.isIntersecting) {
              const mediaKey = (entry.target as HTMLElement).dataset.mediaKey;
              if (mediaKey && !next.has(mediaKey)) {
                next.add(mediaKey);
                newlySeen.push(mediaKey);
                changed = true;
              }
            }
          }

          return changed ? next : current;
        });

        if (newlySeen.length > 0) {
          void markMediaSeen(selected, newlySeen);
        }
      },
      {
        root,
        threshold: 0.65
      }
    );

    const nodes = root.querySelectorAll<HTMLElement>("[data-media-key]");
    nodes.forEach((node) => observer.observe(node));

    return () => {
      observer.disconnect();
    };
  }, [markMediaSeen, mediaFiles, mediaPanelOpen, selectedAgentId]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-overflow-root='true']")) {
        setOverflowAgentId(null);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, []);

  useEffect(() => {
    const lastUsedCwd = selectedAgent?.cwd?.trim() || connectedAgent?.cwd?.trim();
    if (lastUsedCwd) {
      window.localStorage.setItem(LAST_USED_CWD_KEY, lastUsedCwd);
    }
  }, [connectedAgent, selectedAgent]);

  useEffect(() => {
    const value = String(leftOpen);
    window.localStorage.setItem(LEFT_SIDEBAR_KEY, value);
    window.localStorage.setItem(LEFT_SIDEBAR_LEGACY_KEY, value);
  }, [leftOpen]);

  useEffect(() => {
    const value = String(mediaOpen);
    window.localStorage.setItem(MEDIA_SIDEBAR_KEY, value);
    window.localStorage.setItem(MEDIA_SIDEBAR_LEGACY_KEY, value);
  }, [mediaOpen]);

  useEffect(() => {
    if (connState === "connected" && connectedAgentId) {
      persistActiveShellAgentId(connectedAgentId);
      return;
    }
    if (connState === "disconnected" && !restoreShellAgentId) {
      persistActiveShellAgentId(null);
    }
  }, [connState, connectedAgentId, restoreShellAgentId]);

  useEffect(() => {
    if (!createOpen) {
      return;
    }
    void refreshCreateWorktreeMode();
  }, [createOpen, refreshCreateWorktreeMode]);

  const isAttached = connState === "connected" && Boolean(connectedAgentId);
  const canAttachSelected = Boolean(selectedAgent && selectedAgent.status === "running" && !isAttached);
  const showHeaderStatus = connState !== "disconnected";

  const handleSetLeftPanelOpen = useCallback(
    (open: boolean) => {
      if (isMobile) {
        if (open) {
          setMobileMediaOpen(false);
        }
        setMobileLeftOpen(open);
        return;
      }
      setLeftOpen(open);
    },
    [isMobile]
  );

  const handleSetMediaPanelOpen = useCallback(
    (open: boolean) => {
      if (isMobile) {
        if (open) {
          setMobileLeftOpen(false);
        }
        setMobileMediaOpen(open);
        return;
      }
      setMediaOpen(open);
    },
    [isMobile]
  );

  useEffect(() => {
    if (!isMobile) {
      setMobileLeftOpen(false);
      setMobileMediaOpen(false);
    }
  }, [isMobile]);

  const statusText = useMemo(() => {
    if (connState === "reconnecting") {
      if (connectedAgent) {
        return `Reconnecting to session ${connectedAgent.name}...`;
      }
      return "Reconnecting session...";
    }

    if (connState === "connected" && connectedAgent) {
      return `Connected to session ${connectedAgent.name}`;
    }

    if (apiState === "down") {
      return "Unable to reach API service.";
    }

    if (selectedAgent) {
      return `Ready to attach to session ${selectedAgent.name}`;
    }

    return "Select an agent to open a session.";
  }, [apiState, connectedAgent, connState, selectedAgent]);

  const attachSelectedAgent = useCallback(() => {
    if (!selectedAgent || selectedAgent.status !== "running") {
      return;
    }
    void attachToAgent(selectedAgent);
  }, [attachToAgent, selectedAgent]);

  const headerStatusBorderClass =
    connState === "connected"
      ? "border-b-emerald-500"
      : connState === "reconnecting"
        ? "border-b-amber-500"
        : "border-b-border";

  const agentVisualState = useCallback(
    (agent: Agent): AgentVisualState => {
      if (agent.status !== "running") {
        return "stopped";
      }
      if (connState === "connected" && connectedAgentId === agent.id) {
        return "active";
      }
      return "idle";
    },
    [connState, connectedAgentId]
  );

  const borderForAgentState = (state: AgentVisualState): string => {
    if (state === "active") {
      return "border-r-emerald-500";
    }
    if (state === "idle") {
      return "border-r-sky-300";
    }
    return "border-r-zinc-500";
  };

  const mediaDescription = (name: string): string => {
    const trimmed = name.replace(/\.[^/.]+$/, "").replace(/[_.-]+/g, " ").trim();
    if (!trimmed) {
      return "Shared media artifact.";
    }
    return `Shared: ${trimmed}`;
  };

  const unseenMediaCount = useMemo(() => {
    return mediaFiles.filter((file) => !seenMediaKeys.has(`${file.name}:${file.updatedAt}`)).length;
  }, [mediaFiles, seenMediaKeys]);

  const serviceDotClass = (state: ServiceState): string => {
    if (state === "ok") {
      return "bg-emerald-500";
    }
    if (state === "down") {
      return "bg-red-500";
    }
    return "bg-amber-500";
  };

  return (
    <div className="h-full min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex h-full min-h-0 min-w-0 overflow-hidden">
        <div className="hidden md:block">
          <AgentSidebar
            leftOpen={leftOpen}
            agents={agents}
            selectedAgentId={selectedAgentId}
            overflowAgentId={overflowAgentId}
            setLeftOpen={setLeftOpen}
            onOpenCreateDialog={openCreateDialog}
            onOpenEditWorktreeDialog={openEditWorktreeDialog}
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

        <main
          className={cn("min-h-0 min-w-0 flex-1 overflow-hidden", mediaOpen && !isMobile && "border-r-2 border-border")}
        >
          <div className="grid h-full min-h-0 grid-rows-[auto_1fr_auto]">
            <AppHeader
              leftOpen={leftPanelOpen}
              mediaOpen={mediaPanelOpen}
              isMobile={isMobile}
              showHeaderStatus={showHeaderStatus}
              statusText={statusText}
              headerStatusBorderClass={headerStatusBorderClass}
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
              terminalHostRef={terminalHostRef}
            />

            <StatusFooter
              connState={connState}
              apiState={apiState}
              dbState={dbState}
              mediaState={mediaState}
              serviceDotClass={serviceDotClass}
            />
          </div>
        </main>

        <div className="hidden md:block">
          <MediaSidebar
            mediaOpen={mediaOpen}
            mediaFiles={mediaFiles}
            selectedAgentId={selectedAgentId}
            selectedAgentName={selectedAgent?.name ?? null}
            animatingMediaKeys={animatingMediaKeys}
            seenMediaKeys={seenMediaKeys}
            mediaViewportRef={mediaViewportRef}
            setMediaOpen={setMediaOpen}
            mediaDescription={mediaDescription}
            openLightbox={(src, caption) => {
              setLightboxSrc(src);
              setLightboxCaption(caption);
            }}
          />
        </div>
      </div>

      {isMobile ? (
        <MobileSlidePanel
          open={mobileLeftOpen}
          side="left"
          label="Agent sidebar"
          onOpenChange={(open) => {
            if (open) {
              setMobileMediaOpen(false);
            }
            setMobileLeftOpen(open);
          }}
        >
          <AgentSidebarContent
            agents={agents}
            selectedAgentId={selectedAgentId}
            overflowAgentId={overflowAgentId}
            onOpenCreateDialog={openCreateDialog}
            onOpenEditWorktreeDialog={openEditWorktreeDialog}
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
            if (open) {
              setMobileLeftOpen(false);
            }
            setMobileMediaOpen(open);
          }}
        >
            <MediaSidebarContent
              mediaFiles={mediaFiles}
              selectedAgentId={selectedAgentId}
              selectedAgentName={selectedAgent?.name ?? null}
              animatingMediaKeys={animatingMediaKeys}
              seenMediaKeys={seenMediaKeys}
              mediaViewportRef={mediaViewportRef}
              mediaDescription={mediaDescription}
              openLightbox={(src, caption) => {
                setLightboxSrc(src);
                setLightboxCaption(caption);
              }}
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
        worktreeMode={createWorktreeMode}
        worktreeLoading={createWorktreeLoading}
        worktreeSaving={createWorktreeSaving}
        worktreeError={createWorktreeError}
        worktreeRepoRoot={createWorktreeRepoRoot}
        creating={creating}
        setOpen={setCreateOpen}
        setCreateName={setCreateName}
        setCreateType={setCreateType}
        setCreateCwd={setCreateCwd}
        setWorktreeMode={(value) => void setAndPersistWorktreeMode(value)}
        setCreateFullAccess={setCreateFullAccess}
        refreshWorktreeMode={refreshCreateWorktreeMode}
        onSubmit={handleCreateAgent}
      />

      <DeleteAgentDialog
        open={deleteConfirmOpen}
        deleteTarget={deleteTarget}
        setOpen={setDeleteConfirmOpen}
        setDeleteTarget={setDeleteTarget}
        onDelete={deleteAgent}
      />

      <EditWorktreeModeDialog
        open={editWorktreeOpen}
        target={editWorktreeTarget}
        mode={editWorktreeMode}
        loading={editWorktreeLoading}
        saving={editWorktreeSaving}
        error={editWorktreeError}
        setOpen={setEditWorktreeOpen}
        setMode={setEditWorktreeMode}
        onSave={saveEditWorktreeMode}
      />

      <MediaLightbox
        lightboxSrc={lightboxSrc}
        lightboxCaption={lightboxCaption}
        setLightboxSrc={setLightboxSrc}
      />

      <div className="sr-only" aria-live="polite">
        {statusMessage}
      </div>
    </div>
  );
}
