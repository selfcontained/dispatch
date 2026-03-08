import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal as XTerm } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import { AgentSidebar } from "@/components/app/agent-sidebar";
import { AppHeader } from "@/components/app/app-header";
import { CreateAgentDialog } from "@/components/app/create-agent-dialog";
import { DeleteAgentDialog } from "@/components/app/delete-agent-dialog";
import { MediaLightbox } from "@/components/app/media-lightbox";
import { MediaSidebar } from "@/components/app/media-sidebar";
import { StatusFooter } from "@/components/app/status-footer";
import { TerminalPane } from "@/components/app/terminal-pane";
import {
  type Agent,
  type AgentVisualState,
  type ConnState,
  type MediaFile,
  type ServiceState
} from "@/components/app/types";
import { cn } from "@/lib/utils";

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

  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const mediaViewportRef = useRef<HTMLDivElement>(null);

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

  const startAgent = useCallback(
    async (agent: Agent) => {
      setSelectedAgentId(agent.id);
      await api(`/api/v1/agents/${agent.id}/start`, {
        method: "POST",
        body: JSON.stringify({})
      });
      await refreshAgents();
      setStatusMessage(`Started ${agent.name}.`);
    },
    [api, refreshAgents]
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
        <AgentSidebar
          leftOpen={leftOpen}
          agents={agents}
          selectedAgentId={selectedAgentId}
          overflowAgentId={overflowAgentId}
          setLeftOpen={setLeftOpen}
          setCreateOpen={setCreateOpen}
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

        <main
          className={cn("min-h-0 min-w-0 flex-1 overflow-hidden", mediaOpen && "border-r-2 border-border")}
        >
          <div className="grid h-full min-h-0 grid-rows-[auto_1fr_auto]">
            <AppHeader
              leftOpen={leftOpen}
              mediaOpen={mediaOpen}
              showHeaderStatus={showHeaderStatus}
              statusText={statusText}
              headerStatusBorderClass={headerStatusBorderClass}
              isAttached={isAttached}
              unseenMediaCount={unseenMediaCount}
              setLeftOpen={setLeftOpen}
              setMediaOpen={setMediaOpen}
              detachTerminal={detachTerminal}
            />

            <TerminalPane
              isAttached={isAttached}
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

        <MediaSidebar
          mediaOpen={mediaOpen}
          mediaFiles={mediaFiles}
          selectedAgentId={selectedAgentId}
          animatingMediaKeys={animatingMediaKeys}
          mediaViewportRef={mediaViewportRef}
          setMediaOpen={setMediaOpen}
          mediaDescription={mediaDescription}
          openLightbox={(src, caption) => {
            setLightboxSrc(src);
            setLightboxCaption(caption);
          }}
        />
      </div>

      <CreateAgentDialog
        open={createOpen}
        createName={createName}
        createType={createType}
        createCwd={createCwd}
        createFullAccess={createFullAccess}
        creating={creating}
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
