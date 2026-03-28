import { type MutableRefObject, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { type Agent, type AuthState, type ConnState } from "@/components/app/types";
import { api } from "@/lib/api";
import { recordWSReconnect } from "@/lib/energy-metrics";
import { type ThemeId, getTerminalPalette } from "@/hooks/use-theme";

const ACTIVE_SHELL_AGENT_KEY = "dispatch:activeShellAgentId";
const TERMINAL_HEARTBEAT_INTERVAL_MS = 20_000;
const TERMINAL_LIVENESS_GRACE_MS = 5_000;
const TERMINAL_FRESHNESS_MS = TERMINAL_HEARTBEAT_INTERVAL_MS + TERMINAL_LIVENESS_GRACE_MS;
const RESUME_RECONNECT_DEDUPE_MS = 150;
const SOCKET_PROBE_TIMEOUT_MS = 1_500;

type TerminalSocketMessage =
  | { type: "heartbeat"; ts: number }
  | { type: "output"; data: string }
  | { type: "error"; message: string }
  | { type: "exit"; exitCode?: number };

function isTerminalSessionGone(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("session no longer exists") ||
    normalized.includes("session is not available") ||
    normalized.includes("tmux session is no longer running")
  );
}

function isRetriableTerminalFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("invalid or expired terminal token") ||
    normalized.includes("attach failed")
  );
}

function readActiveShellAgentId(): string | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(ACTIVE_SHELL_AGENT_KEY)?.trim();
  return stored && stored.length > 0 ? stored : null;
}

function persistActiveShellAgentId(agentId: string | null): void {
  if (typeof window === "undefined") return;
  if (agentId) {
    window.localStorage.setItem(ACTIVE_SHELL_AGENT_KEY, agentId);
    return;
  }
  window.localStorage.removeItem(ACTIVE_SHELL_AGENT_KEY);
}

/** Strip terminal line-wrap artifacts from copied text. */
function cleanCopiedText(text: string): string {
  const joined = text.replace(/[ \t]*\r?\n[ \t]*/g, "");
  if (/^https?:\/\//.test(joined) || (/\S/.test(joined) && !joined.includes(" "))) {
    return joined;
  }
  return text;
}

export function useTerminal(args: {
  authState: AuthState;
  agents: Agent[];
  agentsLoaded: boolean;
  selectedAgentId: string | null;
  theme: ThemeId;
  isMobile: boolean;
  leftOpen: boolean;
  mediaOpen: boolean;
  onAgentSelected: (agentId: string) => void;
  refreshMedia: (agentId?: string | null) => void;
}): {
  connState: ConnState;
  connectedAgentId: string | null;
  terminalMode: "tmux" | "inert" | null;
  terminalPlaceholderMessage: string | null;
  statusMessage: string;
  terminalHostRef: RefObject<HTMLDivElement>;
  ctrlPendingRef: MutableRefObject<boolean>;
  focusTerminal: () => void;
  ensureTerminalConnected: (clearScreen?: boolean, userInitiated?: boolean, targetAgentId?: string) => Promise<void>;
  detachTerminal: () => void;
  sendTerminalInput: (data: string) => void;
} {
  const {
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
  } = args;

  const [connState, setConnState] = useState<ConnState>("disconnected");
  const [connectedAgentId, setConnectedAgentId] = useState<string | null>(null);
  const [terminalMode, setTerminalMode] = useState<"tmux" | "inert" | null>(null);
  const [terminalPlaceholderMessage, setTerminalPlaceholderMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("Starting...");
  const [restoreShellAgentId, setRestoreShellAgentId] = useState<string | null>(() => readActiveShellAgentId());

  const connectedAgentIdRef = useRef<string | null>(null);
  connectedAgentIdRef.current = connectedAgentId;

  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ctrlPendingRef = useRef(false);

  const wsRef = useRef<WebSocket | null>(null);
  const shouldKeepAttachedRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const attachNonceRef = useRef(0);
  const reconnectInFlightRef = useRef<{
    agentId: string;
    promise: Promise<void>;
  } | null>(null);
  const lastResumeTriggerAtRef = useRef(0);
  const socketHealthRef = useRef({
    lastHeartbeatAt: 0,
    lastOutputAt: 0,
    lastHealthyAt: 0,
    lastOpenAt: 0,
    lastErrorMessage: null as string | null,
    sessionGone: false,
  });

  // Ref for agents so ensureTerminalConnected doesn't get recreated on every
  // SSE-driven agents array update (which would trigger the visibility/focus
  // effect and cause spurious reconnect attempts that abort in-flight connects).
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  const sendResize = useCallback(() => {
    const ws = wsRef.current;
    const term = terminalRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !term) return;
    ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  }, []);

  const clearSocketHealth = useCallback(() => {
    socketHealthRef.current = {
      lastHeartbeatAt: 0,
      lastOutputAt: 0,
      lastHealthyAt: 0,
      lastOpenAt: 0,
      lastErrorMessage: null,
      sessionGone: false,
    };
  }, []);

  const markSocketHealthy = useCallback((source: "open" | "heartbeat" | "output") => {
    const now = Date.now();
    if (source === "open") {
      socketHealthRef.current.lastOpenAt = now;
    } else if (source === "heartbeat") {
      socketHealthRef.current.lastHeartbeatAt = now;
    } else {
      socketHealthRef.current.lastOutputAt = now;
    }
    socketHealthRef.current.lastHealthyAt = now;
    socketHealthRef.current.lastErrorMessage = null;
    socketHealthRef.current.sessionGone = false;
  }, []);

  const noteTerminalError = useCallback((message: string) => {
    socketHealthRef.current.lastErrorMessage = message;
    socketHealthRef.current.sessionGone = isTerminalSessionGone(message);
  }, []);

  const hasFreshSocket = useCallback((agentId: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    if (connectedAgentIdRef.current !== agentId) return false;
    return Date.now() - socketHealthRef.current.lastHealthyAt <= TERMINAL_FRESHNESS_MS;
  }, []);

  /** Probe an open-but-stale socket: send a resize and wait for any server message. */
  const probeSocket = useCallback((agentId: string): Promise<boolean> => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve(false);
    if (connectedAgentIdRef.current !== agentId) return Promise.resolve(false);

    return new Promise((resolve) => {
      let settled = false;
      const settle = (alive: boolean) => {
        if (settled) return;
        settled = true;
        ws.removeEventListener("message", onMsg);
        ws.removeEventListener("close", onClose);
        clearTimeout(timer);
        resolve(alive);
      };

      const onMsg = () => {
        markSocketHealthy("heartbeat");
        settle(true);
      };
      const onClose = () => settle(false);
      const timer = setTimeout(() => settle(false), SOCKET_PROBE_TIMEOUT_MS);

      ws.addEventListener("message", onMsg);
      ws.addEventListener("close", onClose);

      // Trigger server activity by sending a resize.
      const term = terminalRef.current;
      if (term) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    });
  }, [markSocketHealthy]);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const invalidateAttachAttempt = useCallback(() => {
    attachNonceRef.current += 1;
  }, []);

  const closeSocketTransport = useCallback(() => {
    if (wsRef.current) {
      try { wsRef.current.close(); } catch {}
      wsRef.current = null;
    }
    clearSocketHealth();
  }, [clearSocketHealth]);

  const restoreConnectedState = useCallback((agent: Agent, mode: "tmux" | "inert", message?: string) => {
    clearReconnectTimer();
    reconnectAttemptsRef.current = 0;
    setConnState("connected");
    setConnectedAgentId(agent.id);
    setTerminalMode(mode);
    setTerminalPlaceholderMessage(mode === "tmux" ? null : message ?? null);
    setStatusMessage(message ?? `Connected to session ${agent.name}`);
  }, [clearReconnectTimer]);

  const closeSocket = useCallback((announce = true) => {
    closeSocketTransport();
    setConnectedAgentId(null);
    setTerminalMode(null);
    setTerminalPlaceholderMessage(null);

    if (announce) {
      setStatusMessage("Session disconnected.");
      setConnState("disconnected");
    }
  }, [closeSocketTransport]);

  const ensureTerminalConnected = useCallback(
    async (clearScreen = false, userInitiated = false, targetAgentId?: string) => {
      if (userInitiated) {
        shouldKeepAttachedRef.current = true;
      }

      const resolvedAgentId = targetAgentId ?? selectedAgentId;
      if (!shouldKeepAttachedRef.current || !resolvedAgentId) return;

       if (!userInitiated && reconnectInFlightRef.current?.agentId === resolvedAgentId) {
        await reconnectInFlightRef.current.promise;
        return;
      }

      // Nonce is incremented later (just before opening a new WebSocket) so
      // that reusing a fresh socket doesn't invalidate its existing message
      // handler.  Read the current value here for the in-flight guard only.
      let attemptNonce = attachNonceRef.current;
      const isCurrentAttempt = () =>
        shouldKeepAttachedRef.current && attemptNonce === attachNonceRef.current;

      const scheduleReconnect = (message: string) => {
        if (!isCurrentAttempt() || !shouldKeepAttachedRef.current) {
          return;
        }

        reconnectAttemptsRef.current += 1;
        recordWSReconnect();
        const delay = Math.min(1200 * reconnectAttemptsRef.current, 8000);
        setConnState("reconnecting");
        setStatusMessage(message);
        clearReconnectTimer();
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          if (!shouldKeepAttachedRef.current || document.hidden) return;
          void ensureTerminalConnected(false, false, resolvedAgentId);
        }, delay);
      };

      const connectPromise = (async () => {
        let agent: Agent | null = userInitiated
          ? (agentsRef.current.find((item) => item.id === resolvedAgentId) ?? null)
          : null;

        if (!agent || agent.status !== "running") {
          try {
            const payload = await api<{ agent: Agent }>(`/api/v1/agents/${resolvedAgentId}?includeGitContext=false`);
            agent = payload.agent;
          } catch {
            if (!isCurrentAttempt()) return;
            scheduleReconnect("Session disconnected, reconnecting...");
            return;
          }
        }

        if (!isCurrentAttempt() || !agent) return;

        if (agent.status !== "running" && agent.status !== "creating") {
          shouldKeepAttachedRef.current = false;
          clearReconnectTimer();
          closeSocket(false);
          setConnState("disconnected");
          setStatusMessage("Session ended.");
          return;
        }

        if (hasFreshSocket(agent.id)) {
          restoreConnectedState(agent, "tmux");
          sendResize();
          return;
        }

        // Socket is open but stale (no heartbeat during background throttle).
        // Probe it before tearing down — avoids a full reconnect cycle.
        if (wsRef.current?.readyState === WebSocket.OPEN && connectedAgentIdRef.current === agent.id) {
          const alive = await probeSocket(agent.id);
          if (!isCurrentAttempt()) return;
          if (alive) {
            restoreConnectedState(agent, "tmux");
            sendResize();
            return;
          }
        }

        // We're about to create a new WebSocket — NOW increment the nonce to
        // invalidate any previous handler that is still attached.
        attemptNonce = ++attachNonceRef.current;

        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && connectedAgentIdRef.current === agent.id) {
          closeSocketTransport();
        }

        clearReconnectTimer();
        closeSocket(false);

        if (clearScreen) {
          terminalRef.current?.clear();
        }

        fitAddonRef.current?.fit();
        setConnState("reconnecting");
        setStatusMessage(`Connecting to session ${agent.name}...`);

        try {
          const terminalSession = await api<
            | { mode: "tmux"; token: string; wsUrl: string }
            | { mode: "inert"; message: string }
          >(
            `/api/v1/agents/${agent.id}/terminal/token`,
            { method: "POST", body: JSON.stringify({}) }
          );

          if (!isCurrentAttempt()) {
            return;
          }

          if (terminalSession.mode === "inert") {
            restoreConnectedState(agent, "inert", terminalSession.message);
            return;
          }

          const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
          const term = terminalRef.current;
          const cols = term?.cols ?? 140;
          const rows = term?.rows ?? 42;
          setTerminalMode("tmux");
          setTerminalPlaceholderMessage(null);
          const ws = new WebSocket(
            `${protocol}//${window.location.host}${terminalSession.wsUrl}&cols=${cols}&rows=${rows}`
          );
          wsRef.current = ws;

          ws.addEventListener("open", () => {
            if (wsRef.current !== ws || !isCurrentAttempt()) {
              try { ws.close(); } catch {}
              return;
            }
            markSocketHealthy("open");
            restoreConnectedState(agent, "tmux");
            terminalRef.current?.focus();
          });

          ws.addEventListener("message", (event) => {
            if (wsRef.current !== ws || !isCurrentAttempt()) {
              return;
            }
            const payload = JSON.parse(String(event.data)) as TerminalSocketMessage;

            if (payload.type === "heartbeat") {
              markSocketHealthy("heartbeat");
              return;
            }

            if (payload.type === "output") {
              markSocketHealthy("output");
              terminalRef.current?.write(payload.data);
              return;
            }

            if (payload.type === "error") {
              noteTerminalError(payload.message);
              setStatusMessage(`Session error: ${payload.message}`);
              if (isTerminalSessionGone(payload.message)) {
                shouldKeepAttachedRef.current = false;
              }
              return;
            }

            noteTerminalError("Session ended.");
            socketHealthRef.current.sessionGone = true;
            shouldKeepAttachedRef.current = false;
            setStatusMessage("Session ended.");
          });

          ws.addEventListener("close", (event) => {
            if (wsRef.current !== ws || !isCurrentAttempt()) return;
            wsRef.current = null;
            const lastErrorMessage = socketHealthRef.current.lastErrorMessage;
            const sessionGone = socketHealthRef.current.sessionGone;
            clearSocketHealth();

            if (sessionGone) {
              shouldKeepAttachedRef.current = false;
              setConnectedAgentId(null);
              setTerminalMode(null);
              setConnState("disconnected");
              return;
            }

            if (event.code === 1008 && lastErrorMessage && isRetriableTerminalFailure(lastErrorMessage)) {
              scheduleReconnect("Session token expired, retrying...");
              return;
            }

            scheduleReconnect("Session disconnected, reconnecting...");
          });
        } catch (error) {
          if (!isCurrentAttempt()) {
            return;
          }

          const message = error instanceof Error ? error.message : "Session connection failed.";
          if (isTerminalSessionGone(message)) {
            shouldKeepAttachedRef.current = false;
            clearReconnectTimer();
            closeSocket(false);
            setConnState("disconnected");
            setStatusMessage(message);
            return;
          }

          scheduleReconnect(
            isRetriableTerminalFailure(message)
              ? "Session token expired, retrying..."
              : "Session connection failed, retrying..."
          );
        }
      })();

      reconnectInFlightRef.current = { agentId: resolvedAgentId, promise: connectPromise };
      try {
        await connectPromise;
      } finally {
        if (reconnectInFlightRef.current?.promise === connectPromise) {
          reconnectInFlightRef.current = null;
        }
      }
    },
    [
      clearReconnectTimer,
      clearSocketHealth,
      closeSocket,
      closeSocketTransport,
      hasFreshSocket,
      markSocketHealthy,
      noteTerminalError,
      probeSocket,
      restoreConnectedState,
      selectedAgentId,
      sendResize,
    ]
  );

  const detachTerminal = useCallback(() => {
    shouldKeepAttachedRef.current = false;
    invalidateAttachAttempt();
    persistActiveShellAgentId(null);
    setRestoreShellAgentId(null);
    clearReconnectTimer();
    closeSocket(false);
    setConnState("disconnected");
    setStatusMessage("Detached from session.");
  }, [clearReconnectTimer, closeSocket, invalidateAttachAttempt]);

  const sendTerminalInput = useCallback((data: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "input", data }));
    terminalRef.current?.focus();
  }, []);

  // Keep a ref so the xterm init effect can read the current theme without
  // depending on it (we don't want to re-create the terminal on theme change).
  const themeRef = useRef(theme);
  themeRef.current = theme;

  // xterm initialization.
  useEffect(() => {
    const host = terminalHostRef.current;
    if (!host) return;

    const isTouchDevice = window.matchMedia("(pointer: coarse)").matches;

    const palette = getTerminalPalette(themeRef.current);
    const term = new XTerm({
      convertEol: false,
      cursorBlink: true,
      fontFamily: "JetBrains Mono, Menlo, monospace",
      fontSize: 13,
      scrollback: 1000,
      macOptionClickForcesSelection: true,
      screenReaderMode: isTouchDevice,
      minimumContrastRatio: palette.minimumContrastRatio ?? 1,
      theme: palette,
    });

    const fit = new FitAddon();

    terminalRef.current = term;
    fitAddonRef.current = fit;
    term.loadAddon(fit);
    try { term.loadAddon(new ClipboardAddon()); } catch (e) { console.warn("ClipboardAddon failed:", e); }
    term.open(host);
    fit.fit();

    const handleCopy = (e: ClipboardEvent) => {
      if (term.hasSelection()) {
        e.preventDefault();
        e.stopPropagation();
        e.clipboardData?.setData("text/plain", cleanCopiedText(term.getSelection()));
      }
    };
    host.addEventListener("copy", handleCopy, true);

    const screenEl = host.querySelector(".xterm-screen") as HTMLElement | null;
    let touchY = 0;
    let touchAccum = 0;
    const SCROLL_SENSITIVITY = 30;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        touchY = e.touches[0].clientY;
        touchAccum = 0;
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1 || !screenEl) return;
      const currentY = e.touches[0].clientY;
      const delta = touchY - currentY;
      touchY = currentY;
      touchAccum += delta;
      while (Math.abs(touchAccum) >= SCROLL_SENSITIVITY) {
        const direction = touchAccum > 0 ? 1 : -1;
        touchAccum -= direction * SCROLL_SENSITIVITY;
        screenEl.dispatchEvent(new WheelEvent("wheel", {
          deltaY: direction * 100,
          deltaMode: 0,
          bubbles: true,
          cancelable: true,
        }));
      }
    };
    host.addEventListener("touchstart", onTouchStart, { passive: true });
    host.addEventListener("touchmove", onTouchMove, { passive: true });

    let dispatchingMouseDown = false;
    const onMouseDown = (e: MouseEvent) => {
      if (dispatchingMouseDown) return;
      if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      e.stopPropagation();
      e.preventDefault();
      dispatchingMouseDown = true;
      (e.target as HTMLElement).dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        view: window,
        detail: e.detail,
        screenX: e.screenX,
        screenY: e.screenY,
        clientX: e.clientX,
        clientY: e.clientY,
        button: e.button,
        buttons: e.buttons,
        relatedTarget: e.relatedTarget,
        shiftKey: true,
        altKey: true,
      }));
      dispatchingMouseDown = false;
    };
    if (screenEl) {
      screenEl.addEventListener("mousedown", onMouseDown, true);
    }

    const disposable = term.onData((data) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (ctrlPendingRef.current && data.length === 1) {
        const code = data.toUpperCase().charCodeAt(0);
        if (code >= 65 && code <= 90) {
          ctrlPendingRef.current = false;
          window.dispatchEvent(new Event("ctrl-consumed"));
          ws.send(JSON.stringify({ type: "input", data: String.fromCharCode(code - 64) }));
          return;
        }
      }
      ws.send(JSON.stringify({ type: "input", data }));
    });

    const onResize = () => {
      fit.fit();
      sendResize();
    };

    window.addEventListener("resize", onResize);

    return () => {
      invalidateAttachAttempt();
      disposable.dispose();
      host.removeEventListener("copy", handleCopy, true);
      host.removeEventListener("touchstart", onTouchStart);
      host.removeEventListener("touchmove", onTouchMove);
      if (screenEl) screenEl.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("resize", onResize);
      try { wsRef.current?.close(); } catch {}
      wsRef.current = null;
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [authState, invalidateAttachAttempt, sendResize]);

  // Reconnect on visibility/focus.
  useEffect(() => {
    const requestForegroundReconnect = () => {
      const targetAgentId = connectedAgentIdRef.current ?? selectedAgentId ?? undefined;
      if (!targetAgentId) return;
      const now = Date.now();
      if (now - lastResumeTriggerAtRef.current < RESUME_RECONNECT_DEDUPE_MS) {
        return;
      }
      lastResumeTriggerAtRef.current = now;
      void ensureTerminalConnected(false, false, targetAgentId);
    };

    const onVisible = () => {
      if (!document.hidden) {
        requestForegroundReconnect();
      }
    };

    const onFocus = () => {
      requestForegroundReconnect();
    };

    const onOnline = () => {
      clearReconnectTimer();
      void ensureTerminalConnected(false, false, connectedAgentIdRef.current ?? selectedAgentId ?? undefined);
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
    };
  }, [clearReconnectTimer, ensureTerminalConnected, selectedAgentId]);

  // Fit on layout change.
  useEffect(() => {
    if (isMobile) return;
    const fitNow = () => {
      fitAddonRef.current?.fit();
      sendResize();
    };
    fitNow();
    const timer = window.setTimeout(fitNow, 340);
    return () => window.clearTimeout(timer);
  }, [isMobile, leftOpen, mediaOpen, sendResize]);

  // Persist active shell agent.
  useEffect(() => {
    if (connState === "connected" && connectedAgentId) {
      persistActiveShellAgentId(connectedAgentId);
      return;
    }
    if (connState === "disconnected" && !restoreShellAgentId) {
      persistActiveShellAgentId(null);
    }
  }, [connState, connectedAgentId, restoreShellAgentId]);

  // Restore session on load.
  useEffect(() => {
    if (!agentsLoaded || !restoreShellAgentId) return;

    const restoreTarget = agents.find((agent) => agent.id === restoreShellAgentId);
    if (!restoreTarget || restoreTarget.status !== "running") {
      persistActiveShellAgentId(null);
      setRestoreShellAgentId(null);
      return;
    }

    onAgentSelected(restoreTarget.id);
    refreshMedia(restoreTarget.id);
    void ensureTerminalConnected(true, true, restoreTarget.id);
    setStatusMessage(`Restored session for ${restoreTarget.name}.`);
    setRestoreShellAgentId(null);
  }, [agents, agentsLoaded, ensureTerminalConnected, onAgentSelected, refreshMedia, restoreShellAgentId]);


  // Update terminal palette and reconnect when theme changes.
  const prevThemeRef = useRef(theme);
  useEffect(() => {
    if (prevThemeRef.current === theme) return;
    prevThemeRef.current = theme;

    // Update xterm palette in-place
    const term = terminalRef.current;
    if (term) {
      const palette = getTerminalPalette(theme);
      term.options.theme = palette;
      term.options.minimumContrastRatio = palette.minimumContrastRatio ?? 1;
    }

    // Reconnect so tmux re-sends viewport with the new palette colors
    if (connState !== "connected" || !connectedAgentId) return;
    const agentId = connectedAgentId;
    detachTerminal();
    const timer = window.setTimeout(() => {
      void ensureTerminalConnected(true, true, agentId);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [theme, connState, connectedAgentId, detachTerminal, ensureTerminalConnected]);

  const focusTerminal = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  return useMemo(() => ({
    connState,
    connectedAgentId,
    terminalMode,
    terminalPlaceholderMessage,
    statusMessage,
    terminalHostRef: terminalHostRef as RefObject<HTMLDivElement>,
    ctrlPendingRef,
    focusTerminal,
    ensureTerminalConnected,
    detachTerminal,
    sendTerminalInput,
  }), [
    connState,
    connectedAgentId,
    terminalMode,
    terminalPlaceholderMessage,
    statusMessage,
    focusTerminal,
    ensureTerminalConnected,
    detachTerminal,
    sendTerminalInput,
  ]);
}
