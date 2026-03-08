import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal as XTerm } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  EllipsisVertical,
  Image as ImageIcon,
  Loader2,
  Pause,
  Play,
  Plus,
  Square,
  TerminalSquare,
  Wifi,
  Database,
  Server
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type AgentStatus = "creating" | "running" | "stopping" | "stopped" | "error" | "unknown";

type Agent = {
  id: string;
  name: string;
  status: AgentStatus;
  cwd: string;
  tmuxSession: string | null;
  codexArgs: string[];
  lastError?: string | null;
  mediaDir: string | null;
  createdAt: string;
  updatedAt: string;
};

type MediaFile = {
  name: string;
  size: number;
  updatedAt: string;
  url: string;
};

type ConnState = "connected" | "reconnecting" | "disconnected";
type ServiceState = "ok" | "down" | "checking";
type AgentVisualState = "stopped" | "idle" | "active";

const DEFAULT_CWD = "/Users/bharris/dev/apps/hostess";
const FULL_ACCESS_ARG = "--dangerously-bypass-approvals-and-sandbox";

function isFullAccessEnabled(agent: Pick<Agent, "codexArgs">): boolean {
  return agent.codexArgs.includes(FULL_ACCESS_ARG);
}

export function App(): JSX.Element {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const [connState, setConnState] = useState<ConnState>("disconnected");
  const [connectedAgentId, setConnectedAgentId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("Starting...");

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createCwd, setCreateCwd] = useState(DEFAULT_CWD);
  const [createType, setCreateType] = useState("codex");
  const [createFullAccess, setCreateFullAccess] = useState(false);
  const [creating, setCreating] = useState(false);

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Agent | null>(null);

  const [leftOpen, setLeftOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return true;
    }
    const stored = window.localStorage.getItem("hostess:leftSidebarOpen");
    return stored === null ? true : stored === "true";
  });
  const [mediaOpen, setMediaOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return false;
    }
    const stored = window.localStorage.getItem("hostess:mediaSidebarOpen");
    return stored === null ? false : stored === "true";
  });
  const [overflowAgentId, setOverflowAgentId] = useState<string | null>(null);

  const [mediaFiles, setMediaFiles] = useState<MediaFile[]>([]);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [lightboxCaption, setLightboxCaption] = useState("");
  const [seenMediaKeys, setSeenMediaKeys] = useState<Set<string>>(new Set());
  const [animatingMediaKeys, setAnimatingMediaKeys] = useState<Set<string>>(new Set());

  const [apiState, setApiState] = useState<ServiceState>("checking");
  const [dbState, setDbState] = useState<ServiceState>("checking");
  const [mediaState, setMediaState] = useState<ServiceState>("checking");

  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const mediaViewportRef = useRef<HTMLDivElement | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const shouldKeepAttachedRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const attachNonceRef = useRef(0);
  const mediaPollTimerRef = useRef<number | null>(null);
  const agentPollTimerRef = useRef<number | null>(null);
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
    setAgents(payload.agents);

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
        setMediaState("checking");
        return;
      }

      try {
        const payload = await api<{ files: MediaFile[] }>(`/api/v1/agents/${id}/media`);
        setMediaFiles(payload.files ?? []);
        setMediaState("ok");
      } catch {
        setMediaFiles([]);
        setMediaState("down");
      }
    },
    [api, selectedAgentId]
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
      setStatusMessage("Terminal disconnected.");
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
        const payload = await api<{ agent: Agent }>(`/api/v1/agents/${resolvedAgentId}`);
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
      setStatusMessage(`Connecting terminal to ${agent.name}...`);

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
        setStatusMessage(`Connected to agent ${agent.name}`);
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
          setStatusMessage(`Terminal error: ${payload.message}`);
        } else if (payload.type === "exit") {
          setStatusMessage("Terminal session ended.");
        }
      });

      ws.addEventListener("close", () => {
        if (wsRef.current !== ws) {
          return;
        }

        wsRef.current = null;

        if (!shouldKeepAttachedRef.current || attachNonce !== attachNonceRef.current) {
          setConnState("disconnected");
          return;
        }

        reconnectAttemptsRef.current += 1;
        const delay = Math.min(1200 * reconnectAttemptsRef.current, 8000);
        setConnState("reconnecting");
        setStatusMessage("Terminal lost, reconnecting...");

        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          void ensureTerminalConnected(false, false, resolvedAgentId);
        }, delay);
      });
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
    clearReconnectTimer();
    closeSocket(false);
    setConnState("disconnected");
    setStatusMessage("Terminal detached.");
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
      await refreshMedia(agent.id);
      await ensureTerminalConnected(true, true, agent.id);
    },
    [ensureTerminalConnected, refreshMedia]
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
        setSelectedAgentId(payload.agent.id);
        await refreshAgents();
        await refreshMedia(payload.agent.id);
        await ensureTerminalConnected(true, true, payload.agent.id);
        setStatusMessage(`Created ${payload.agent.name} and attached terminal.`);
      } finally {
        setCreating(false);
      }
    },
    [api, createCwd, createFullAccess, createName, createType, ensureTerminalConnected, refreshAgents, refreshMedia]
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
      theme: { background: "#090a08", foreground: "#f8f8f2" }
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
    void (async () => {
      await Promise.all([pollHealth(), refreshAgents()]);
      setStatusMessage("Select an agent to open a terminal connection.");
    })();
  }, [pollHealth, refreshAgents]);

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
    if (agentPollTimerRef.current) {
      window.clearInterval(agentPollTimerRef.current);
    }
    agentPollTimerRef.current = window.setInterval(() => {
      void refreshAgents();
    }, 4000);

    return () => {
      if (agentPollTimerRef.current) {
        window.clearInterval(agentPollTimerRef.current);
        agentPollTimerRef.current = null;
      }
    };
  }, [refreshAgents]);

  useEffect(() => {
    if (mediaPollTimerRef.current) {
      window.clearInterval(mediaPollTimerRef.current);
    }
    mediaPollTimerRef.current = window.setInterval(() => {
      void refreshMedia();
    }, 4000);

    return () => {
      if (mediaPollTimerRef.current) {
        window.clearInterval(mediaPollTimerRef.current);
        mediaPollTimerRef.current = null;
      }
    };
  }, [refreshMedia]);

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
    const fitNow = () => {
      fitAddonRef.current?.fit();
      sendResize();
    };

    fitNow();
    const timer = window.setTimeout(fitNow, 340);
    return () => window.clearTimeout(timer);
  }, [leftOpen, mediaOpen, sendResize]);

  useEffect(() => {
    setSeenMediaKeys(new Set());
  }, [selectedAgentId]);

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
        }, 320);
      }
    }

    previousMediaKeysRef.current = new Set(nextKeys);
  }, [mediaFiles]);

  useEffect(() => {
    if (!mediaOpen) {
      return;
    }

    const root = mediaViewportRef.current;
    if (!root) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        setSeenMediaKeys((current) => {
          let changed = false;
          const next = new Set(current);

          for (const entry of entries) {
            if (entry.isIntersecting) {
              const mediaKey = (entry.target as HTMLElement).dataset.mediaKey;
              if (mediaKey && !next.has(mediaKey)) {
                next.add(mediaKey);
                changed = true;
              }
            }
          }

          return changed ? next : current;
        });
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
  }, [mediaFiles, mediaOpen]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-overflow-root='true']")) {
        setOverflowAgentId(null);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem("hostess:leftSidebarOpen", String(leftOpen));
  }, [leftOpen]);

  useEffect(() => {
    window.localStorage.setItem("hostess:mediaSidebarOpen", String(mediaOpen));
  }, [mediaOpen]);

  const isAttached = connState === "connected" && Boolean(connectedAgentId);
  const showHeaderStatus = connState !== "disconnected";

  const statusText = useMemo(() => {
    if (connState === "reconnecting") {
      if (connectedAgent) {
        return `Reconnecting to agent ${connectedAgent.name}...`;
      }
      return "Reconnecting terminal session...";
    }

    if (connState === "connected" && connectedAgent) {
      return `Connected to agent ${connectedAgent.name}`;
    }

    if (apiState === "down") {
      return "Unable to reach API service.";
    }

    if (selectedAgent) {
      return `Ready to connect to agent ${selectedAgent.name}`;
    }

    return "Select an agent to open a terminal connection.";
  }, [apiState, connectedAgent, connState, selectedAgent]);

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
      return "border-r-sky-400";
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
        <div
          className="h-full min-w-0 flex-none overflow-hidden transition-[width] duration-300 ease-out"
          style={{ width: leftOpen ? 320 : 0 }}
        >
          <aside className="flex h-full min-h-0 w-[320px] flex-col border-r-2 border-sky-900/80 bg-sky-950 text-slate-50">
            <div className="flex h-14 items-center px-3">
              <div className="text-lg font-semibold tracking-wide">Hostess</div>
              <div className="ml-auto">
                <Button size="icon" variant="ghost" onClick={() => setLeftOpen(false)} title="Close sidebar">
                  <ChevronLeft className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="mt-2 flex h-14 items-center border-b border-sky-900/80 px-3">
              <div className="text-sm font-semibold uppercase tracking-wide text-sky-200/80">Agents</div>
              <div className="ml-auto flex items-center">
                <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}>
                  <Plus className="mr-1 h-3.5 w-3.5" /> Create
                </Button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {agents.length === 0 ? (
                <div className="p-4 text-sm text-sky-200/70">No agents yet.</div>
              ) : (
                agents.map((agent) => {
                  const state = agentVisualState(agent);
                  const isSelected = selectedAgentId === agent.id;
                  const isStopped = state === "stopped";
                  const isActive = state === "active";
                  const isExpanded = isActive || isSelected;
                  const fullAccessEnabled = isFullAccessEnabled(agent);
                  const needsAttention = agent.status === "error";

                  return (
                    <div
                      key={agent.id}
                      onClick={(event) => {
                        const target = event.target as HTMLElement;
                        if (target.closest("[data-agent-control='true']") || isActive) {
                          return;
                        }
                        toggleAgentDetails(agent.id);
                      }}
                      className={cn(
                        "border-b border-r-2 border-sky-900/70 px-2 py-2",
                        borderForAgentState(state),
                        isSelected && "bg-sky-900/50",
                        !isActive && "cursor-pointer"
                      )}
                    >
                      <div className="flex items-center gap-1.5">
                        <button
                          data-agent-control="true"
                          className="min-w-0 flex-1 truncate text-left text-sm font-semibold"
                          onClick={() => {
                            if (!isActive) {
                              toggleAgentDetails(agent.id);
                            }
                          }}
                          title={agent.cwd}
                        >
                          {agent.name}
                        </button>

                        {needsAttention ? (
                          <Badge
                            className="border-red-400/45 bg-red-500/15 text-red-200"
                            title={agent.lastError ?? "Agent entered an error state and may need attention."}
                          >
                            Attention
                          </Badge>
                        ) : null}

                        <button
                          type="button"
                          data-agent-control="true"
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                            isActive
                              ? "bg-emerald-500/15 text-emerald-300"
                              : isStopped
                                ? "bg-zinc-500/15 text-zinc-300"
                                : "bg-sky-400/15 text-sky-300"
                          )}
                        >
                          {isActive ? "Active" : agent.status === "running" ? "Detached" : agent.status}
                        </button>

                        {isStopped ? (
                          <Button
                            size="icon"
                            data-agent-control="true"
                            onClick={async () => {
                              setSelectedAgentId(agent.id);
                              await api(`/api/v1/agents/${agent.id}/start`, {
                                method: "POST",
                                body: JSON.stringify({})
                              });
                              await refreshAgents();
                              setStatusMessage(`Started ${agent.name}.`);
                            }}
                            title="Start agent"
                          >
                            <Play className="h-3.5 w-3.5" />
                          </Button>
                        ) : (
                          <>
                            {isActive ? (
                              <Button
                                size="icon"
                                variant="ghost"
                                data-agent-control="true"
                                onClick={detachTerminal}
                                title="Pause (detach terminal)"
                              >
                                <Pause className="h-3.5 w-3.5" />
                              </Button>
                            ) : (
                              <Button
                                size="icon"
                                data-agent-control="true"
                                onClick={() => void attachToAgent(agent)}
                                title="Play (attach terminal)"
                              >
                                <Play className="h-3.5 w-3.5" />
                              </Button>
                            )}

                            {isActive ? (
                              <Button
                                size="icon"
                                variant="destructive"
                                data-agent-control="true"
                                onClick={() => void stopAgent(agent)}
                                title="Stop agent"
                              >
                                <Square className="h-3.5 w-3.5" />
                              </Button>
                            ) : null}
                          </>
                        )}

                        <div className="relative ml-auto" data-overflow-root="true">
                          <Button
                            size="icon"
                            variant="ghost"
                            data-agent-control="true"
                            title="More actions"
                            onClick={() =>
                              setOverflowAgentId((current) => (current === agent.id ? null : agent.id))
                            }
                          >
                            <EllipsisVertical className="h-4 w-4" />
                          </Button>

                          {overflowAgentId === agent.id ? (
                            <div className="absolute right-0 top-9 z-30 min-w-[180px] border-2 border-sky-800 bg-sky-950 p-1.5 shadow-lg">
                              <button
                                data-agent-control="true"
                                className="w-full border border-transparent px-2 py-1.5 text-left text-sm text-red-300 hover:border-border hover:bg-muted/50"
                                onClick={() => {
                                  setOverflowAgentId(null);
                                  setDeleteTarget(agent);
                                  setDeleteConfirmOpen(true);
                                }}
                              >
                                Delete agent
                              </button>
                            </div>
                          ) : null}
                        </div>
                      </div>

                      <div
                        className={cn(
                          "grid overflow-hidden transition-[grid-template-rows,opacity,margin] duration-300 ease-out",
                          isExpanded ? "mt-2 grid-rows-[1fr] opacity-100" : "mt-0 grid-rows-[0fr] opacity-0"
                        )}
                      >
                        <div className="min-h-0 overflow-hidden">
                          <div className="px-3 pt-1">
                            <div className="grid gap-2 text-xs text-muted-foreground">
                              <AgentMeta label="Working dir" value={agent.cwd} mono />
                              <AgentMeta label="Agent type" value="Codex" />
                              <AgentMeta label="Full access" value={fullAccessEnabled ? "Enabled" : "Disabled"} />
                              {agent.lastError ? <AgentMeta label="Last error" value={agent.lastError} /> : null}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </aside>
        </div>

        <main
          className={cn("min-h-0 min-w-0 flex-1 overflow-hidden", mediaOpen && "border-r-2 border-border")}
        >
          <div className="grid h-full min-h-0 grid-rows-[auto_1fr_auto]">
            <header className={cn("flex h-14 items-center border-b-2 bg-[#11120f] px-3", headerStatusBorderClass)}>
              <div className="flex min-w-0 items-center gap-2">
                {!leftOpen ? (
                  <Button size="icon" variant="ghost" onClick={() => setLeftOpen(true)} title="Open agent sidebar">
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                ) : null}
                {showHeaderStatus ? <span className="truncate text-sm">{statusText}</span> : null}
              </div>

              <div className="ml-auto flex items-center gap-2">
                {isAttached ? (
                  <Button size="sm" variant="ghost" onClick={detachTerminal}>
                    <Pause className="mr-1 h-3.5 w-3.5" /> Pause
                  </Button>
                ) : null}

                {!mediaOpen ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="relative"
                    onClick={() => setMediaOpen(true)}
                    title="Open media sidebar"
                  >
                    <ImageIcon className="h-4 w-4" />
                    {unseenMediaCount > 0 ? (
                      <span className="absolute -right-1.5 -top-1.5 min-w-5 rounded-full border border-border bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                        {unseenMediaCount}
                      </span>
                    ) : null}
                  </Button>
                ) : null}
              </div>
            </header>

            <div className="relative h-full min-h-0 overflow-hidden bg-[#090a08]">
              <div className={cn("h-full w-full", !isAttached && connState !== "reconnecting" && "invisible")}>
                <div className="h-full" ref={terminalHostRef} />
              </div>

              {!isAttached ? (
                <div className="absolute inset-0 z-20 grid place-items-center bg-[#090a08]">
                  <div className="flex max-w-md flex-col items-center gap-2 px-6 text-center text-muted-foreground">
                    <TerminalSquare className="h-8 w-8" />
                    <p className="text-sm">Select an agent and press Play to open a terminal connection.</p>
                  </div>
                </div>
              ) : null}

              {connState === "reconnecting" ? (
                <div className="absolute inset-0 z-30 grid place-items-center bg-black/75">
                  <div className="flex flex-col items-center gap-2 text-sm text-amber-200">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    <span>{statusMessage}</span>
                  </div>
                </div>
              ) : null}
            </div>

            <footer className="grid h-11 grid-cols-4 items-center border-t-2 border-border bg-[#11120f] px-3 text-xs text-muted-foreground">
              <ServiceStatus icon={<Wifi className="h-3.5 w-3.5" />} label="WS" value={connState} dotClass={serviceDotClass(connState === "connected" ? "ok" : connState === "reconnecting" ? "checking" : "down")} />
              <ServiceStatus icon={<Server className="h-3.5 w-3.5" />} label="API" value={apiState} dotClass={serviceDotClass(apiState)} />
              <ServiceStatus icon={<Database className="h-3.5 w-3.5" />} label="Database" value={dbState} dotClass={serviceDotClass(dbState)} />
              <ServiceStatus icon={<ImageIcon className="h-3.5 w-3.5" />} label="Media" value={mediaState} dotClass={serviceDotClass(mediaState)} />
            </footer>
          </div>
        </main>

        <div
          className="h-full min-w-0 flex-none overflow-hidden transition-[width] duration-300 ease-out"
          style={{ width: mediaOpen ? 360 : 0 }}
        >
          <aside className="flex h-full min-h-0 w-[360px] flex-col bg-card">
            <div className="flex h-14 items-center px-3">
              <div className="text-sm font-semibold uppercase tracking-wide">Media Stream</div>
              <div className="ml-auto flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{mediaFiles.length} items</span>
                <Button size="icon" variant="ghost" onClick={() => setMediaOpen(false)} title="Close media sidebar">
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div ref={mediaViewportRef} className="min-h-0 flex-1 overflow-y-auto">
              {mediaFiles.length === 0 ? (
                <div className="grid h-full place-items-center p-4 text-center text-sm text-muted-foreground">
                  {selectedAgent ? "No media yet." : "Select an agent to view media."}
                </div>
              ) : (
                mediaFiles.map((file) => {
                  const mediaKey = `${file.name}:${file.updatedAt}`;
                  return (
                    <article
                      key={mediaKey}
                      data-media-key={mediaKey}
                      className={cn(
                        "border-b-2 border-border px-3 py-3",
                        animatingMediaKeys.has(mediaKey) && "animate-media-in"
                      )}
                    >
                      <div className="mb-2 text-xs text-muted-foreground">
                        {new Date(file.updatedAt).toLocaleString()}
                      </div>
                      <button
                        className="block w-full overflow-hidden border-2 border-border bg-black/60"
                        onClick={() => {
                          setLightboxSrc(`${file.url}?t=${encodeURIComponent(file.updatedAt)}`);
                          setLightboxCaption(file.name);
                        }}
                      >
                        <img
                          src={`${file.url}?t=${encodeURIComponent(file.updatedAt)}`}
                          alt={file.name}
                          className="max-h-[260px] w-full object-contain"
                        />
                      </button>
                      <div className="mt-2 text-xs text-muted-foreground">
                        <div>{mediaDescription(file.name)}</div>
                        <div className="mt-1">{Math.max(1, Math.round(file.size / 1024))} KB</div>
                      </div>
                    </article>
                  );
                })
              )}
            </div>
          </aside>
        </div>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Agent</DialogTitle>
            <DialogDescription>Name, type, and working directory for a new agent session.</DialogDescription>
          </DialogHeader>

          <form className="space-y-3" onSubmit={(event) => void handleCreateAgent(event)}>
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">Name</label>
              <Input
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                placeholder="agent name (optional)"
              />
            </div>

            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">Type</label>
              <select
                value={createType}
                onChange={(event) => setCreateType(event.target.value)}
                className="flex h-9 w-full border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="codex">Codex</option>
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">Working directory</label>
              <Input
                value={createCwd}
                onChange={(event) => setCreateCwd(event.target.value)}
                placeholder="/absolute/path"
                required
              />
            </div>

            <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
              <button
                type="button"
                role="checkbox"
                aria-checked={createFullAccess}
                onClick={() => setCreateFullAccess((current) => !current)}
                className={cn(
                  "mt-0.5 inline-flex h-5 w-5 items-center justify-center border text-foreground transition-colors",
                  createFullAccess ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background"
                )}
                title="Toggle full access"
              >
                {createFullAccess ? <Check className="h-3.5 w-3.5" /> : null}
              </button>
              <span className="space-y-1">
                <span className="block text-sm font-medium text-foreground">Start in full access mode</span>
                <span className="block text-xs text-muted-foreground">
                  Starts Codex with sandboxing and approval prompts disabled.
                </span>
              </span>
            </label>

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={creating}>
                {creating ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />}
                Create
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Agent</DialogTitle>
            <DialogDescription>
              {deleteTarget
                ? `Delete \"${deleteTarget.name}\"? This permanently removes the agent record and all media files.`
                : "Delete this agent?"}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setDeleteConfirmOpen(false);
                setDeleteTarget(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (!deleteTarget) {
                  return;
                }
                await deleteAgent(deleteTarget);
                setDeleteConfirmOpen(false);
                setDeleteTarget(null);
              }}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {lightboxSrc ? (
        <div
          className="fixed inset-0 z-[120] grid grid-rows-[auto_1fr_auto] gap-3 bg-black/90 p-4"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setLightboxSrc(null);
            }
          }}
        >
          <div className="flex justify-end">
            <Button onClick={() => setLightboxSrc(null)}>Close</Button>
          </div>
          <div className="grid min-h-0 place-items-center">
            <img
              src={lightboxSrc}
              alt={lightboxCaption}
              className="max-h-[calc(100vh-8rem)] max-w-[calc(100vw-2rem)] h-auto w-auto object-contain"
            />
          </div>
          <div className="text-center text-sm text-muted-foreground">{lightboxCaption}</div>
        </div>
      ) : null}

      <div className="sr-only" aria-live="polite">
        {statusMessage}
      </div>
    </div>
  );
}

function ServiceStatus({
  icon,
  label,
  value,
  dotClass
}: {
  icon: JSX.Element;
  label: string;
  value: string;
  dotClass: string;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      {icon}
      <span>{label}</span>
      <span className={cn("h-2.5 w-2.5 rounded-full", dotClass)} />
      <span className="truncate uppercase">{value}</span>
    </div>
  );
}

function AgentMeta({
  label,
  value,
  mono = false
}: {
  label: string;
  value: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <div className="grid gap-1">
      <div className="uppercase tracking-wide text-[10px] text-muted-foreground/80">{label}</div>
      <div className={cn("break-all text-foreground", mono && "font-mono text-[11px]")}>{value}</div>
    </div>
  );
}
