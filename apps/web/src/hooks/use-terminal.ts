import {
  type MutableRefObject,
  type RefCallback,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import {
  type Agent,
  type AuthState,
  type ConnState,
  type TerminalCopyMode,
  type TerminalUiState,
} from "@/components/app/types";
import { useAgentSettings } from "@/hooks/use-agent-settings";
import { api } from "@/lib/api";
import { recordWSReconnect } from "@/lib/energy-metrics";
import { type ThemeId, getTerminalPalette } from "@/hooks/use-theme";

const TERMINAL_HEARTBEAT_INTERVAL_MS = 20_000;
const TERMINAL_LIVENESS_GRACE_MS = 5_000;
const TERMINAL_FRESHNESS_MS =
  TERMINAL_HEARTBEAT_INTERVAL_MS + TERMINAL_LIVENESS_GRACE_MS;
const RESUME_RECONNECT_DEDUPE_MS = 150;
const SOCKET_PROBE_TIMEOUT_MS = 1_500;

function getTerminalFontFamily(): string {
  const fontFamily = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-terminal")
    .trim();
  return fontFamily.length > 0
    ? fontFamily
    : '"JetBrains Mono", Menlo, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", monospace';
}

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

/** Strip terminal line-wrap artifacts from copied text. */
function cleanCopiedText(text: string): string {
  const joined = text.replace(/[ \t]*\r?\n[ \t]*/g, "");
  if (
    /^https?:\/\//.test(joined) ||
    (/\S/.test(joined) && !joined.includes(" "))
  ) {
    return joined;
  }
  return text;
}

function focusTerminalSurface(term: XTerm | null): void {
  if (!term) return;
  term.focus();
  requestAnimationFrame(() => {
    term.focus();
    window.setTimeout(() => {
      term.focus();
    }, 0);
  });
}

export function useTerminal(args: {
  authState: AuthState;
  agents: Agent[];
  selectedAgentId: string | null;
  theme: ThemeId;
  isMobile: boolean;
  leftOpen: boolean;
  deferMediaResize: boolean;
  mediaResizeSettleKey: number;
  feedbackOpen: boolean;
}): {
  connState: ConnState;
  connectedAgentId: string | null;
  terminalMode: "tmux" | "inert" | null;
  terminalPlaceholderMessage: string | null;
  inCopyMode: boolean;
  copyMode: TerminalCopyMode | "unknown";
  statusMessage: string;
  terminalHostRef: RefCallback<HTMLDivElement>;
  ctrlPendingRef: MutableRefObject<boolean>;
  focusTerminal: () => void;
  ensureTerminalConnected: (
    clearScreen?: boolean,
    userInitiated?: boolean,
    targetAgentId?: string
  ) => Promise<void>;
  detachTerminal: () => void;
  sendTerminalInput: (data: string) => void;
  exitCopyMode: () => Promise<void>;
  resyncing: boolean;
} {
  const {
    authState,
    agents,
    selectedAgentId,
    theme,
    isMobile,
    leftOpen,
    deferMediaResize,
    mediaResizeSettleKey,
    feedbackOpen,
  } = args;
  const queryClient = useQueryClient();

  const [connState, setConnState] = useState<ConnState>("disconnected");
  const [connectedAgentId, setConnectedAgentId] = useState<string | null>(null);
  const [terminalMode, setTerminalMode] = useState<"tmux" | "inert" | null>(
    null
  );
  const [terminalPlaceholderMessage, setTerminalPlaceholderMessage] = useState<
    string | null
  >(null);
  const [exitPending, setExitPending] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Starting...");
  // True while requestFit's auto-RESYNC is in flight. Lets the UI show a
  // calm "Resizing…" overlay instead of the empty / reconnect overlays
  // that the underlying detach → reattach transition would otherwise expose.
  const [resyncing, setResyncing] = useState(false);

  const connectedAgentIdRef = useRef<string | null>(null);
  connectedAgentIdRef.current = connectedAgentId;

  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const [terminalHostElement, setTerminalHostElement] =
    useState<HTMLDivElement | null>(null);
  const setTerminalHostRef = useCallback((node: HTMLDivElement | null) => {
    terminalHostRef.current = node;
    setTerminalHostElement(node);
  }, []);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const fitDebounceRef = useRef<number | null>(null);
  const ctrlPendingRef = useRef(false);
  const copyModeRef = useRef<TerminalCopyMode | "unknown">("live");
  const exitCopyModeRef = useRef<() => Promise<void>>(async () => {});
  const noteScrollInteractionRef = useRef<() => void>(() => {});
  // Filled in via effect once detachTerminal/ensureTerminalConnected exist —
  // lets requestFit trigger an auto-RESYNC without needing those defined
  // earlier in the hook body.
  const resyncOnResizeRef = useRef<() => void>(() => {});

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
  const deferMediaResizeRef = useRef(deferMediaResize);
  deferMediaResizeRef.current = deferMediaResize;
  const lastInteractionHintAtRef = useRef(0);

  const { data: agentSettings } = useAgentSettings();
  const copyModeAssistEnabled = agentSettings?.copyModeAssistEnabled ?? false;
  const copyModeAssistEnabledRef = useRef(copyModeAssistEnabled);
  copyModeAssistEnabledRef.current = copyModeAssistEnabled;

  const { data: terminalState } = useQuery<TerminalUiState>({
    queryKey: ["terminal-state", connectedAgentId],
    queryFn: async () => {
      if (!connectedAgentId) {
        return { copyMode: "live", lastObservedAt: 0 };
      }
      const payload = await api<{ terminalState: TerminalUiState }>(
        `/api/v1/agents/${connectedAgentId}/terminal/state`
      );
      return payload.terminalState;
    },
    enabled:
      copyModeAssistEnabled &&
      terminalMode === "tmux" &&
      connState === "connected" &&
      connectedAgentId !== null,
    refetchOnWindowFocus: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const serverCopyMode =
    terminalMode !== "tmux" || !copyModeAssistEnabled
      ? "live"
      : (terminalState?.copyMode ?? "unknown");
  const copyMode: TerminalCopyMode | "unknown" =
    exitPending &&
    (serverCopyMode === "unknown" || serverCopyMode === "exiting")
      ? "exiting"
      : serverCopyMode;
  copyModeRef.current = copyMode;

  const sendResize = useCallback(() => {
    const ws = wsRef.current;
    const term = terminalRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !term) return;
    ws.send(
      JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })
    );
  }, []);

  // Trailing-debounced size-change detector. ResizeObserver and CSS
  // transitions can fire many size changes per visual settle; we wait 300ms
  // for the host to stop moving, then ask the fit addon what cols/rows it
  // would propose. If they differ from xterm's current dims, we full-RESYNC
  // (tear down the WebSocket and re-attach with the new size in the URL).
  //
  // Why RESYNC instead of just calling fit()? xterm's destructive resize
  // leaves stale state behind — cursor saves, scroll regions, app modes,
  // scrollback rows wrapped at the old cols — that the agent's incremental
  // redraws after SIGWINCH can't fully overwrite. Subsequent positioned
  // writes start landing wrong as new bytes arrive. A reattach pulls a
  // fresh viewport from tmux into a clean buffer, same as a page reload.
  const requestFit = useCallback(() => {
    if (fitDebounceRef.current !== null) {
      window.clearTimeout(fitDebounceRef.current);
    }
    fitDebounceRef.current = window.setTimeout(() => {
      fitDebounceRef.current = null;
      const term = terminalRef.current;
      const fit = fitAddonRef.current;
      if (!term || !fit) return;
      const proposed = fit.proposeDimensions();
      if (!proposed) return;
      if (proposed.cols === term.cols && proposed.rows === term.rows) return;
      resyncOnResizeRef.current();
    }, 300);
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

  const resetTerminalState = useCallback(() => {
    setExitPending(false);
  }, []);

  const markSocketHealthy = useCallback(
    (source: "open" | "heartbeat" | "output") => {
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
    },
    []
  );

  const noteTerminalError = useCallback((message: string) => {
    socketHealthRef.current.lastErrorMessage = message;
    socketHealthRef.current.sessionGone = isTerminalSessionGone(message);
  }, []);

  const hasFreshSocket = useCallback((agentId: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    if (connectedAgentIdRef.current !== agentId) return false;
    return (
      Date.now() - socketHealthRef.current.lastHealthyAt <=
      TERMINAL_FRESHNESS_MS
    );
  }, []);

  /** Probe an open-but-stale socket: send a resize and wait for any server message. */
  const probeSocket = useCallback(
    (agentId: string): Promise<boolean> => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN)
        return Promise.resolve(false);
      if (connectedAgentIdRef.current !== agentId)
        return Promise.resolve(false);

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
          ws.send(
            JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })
          );
        }
      });
    },
    [markSocketHealthy]
  );

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const invalidateAttachAttempt = useCallback(() => {
    attachNonceRef.current += 1;
  }, []);

  const resetTerminalSurface = useCallback(() => {
    const term = terminalRef.current;
    if (!term) return;
    term.reset();
    term.clear();
  }, []);

  const closeSocketTransport = useCallback(() => {
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }
    clearSocketHealth();
  }, [clearSocketHealth]);

  const restoreConnectedState = useCallback(
    (agent: Agent, mode: "tmux" | "inert", message?: string) => {
      clearReconnectTimer();
      reconnectAttemptsRef.current = 0;
      setConnState("connected");
      setConnectedAgentId(agent.id);
      setTerminalMode(mode);
      setTerminalPlaceholderMessage(mode === "tmux" ? null : (message ?? null));
      setStatusMessage(message ?? `Connected to session ${agent.name}`);
    },
    [clearReconnectTimer]
  );

  const closeSocket = useCallback(
    (announce = true) => {
      closeSocketTransport();
      resetTerminalState();
      setConnectedAgentId(null);
      setTerminalMode(null);
      setTerminalPlaceholderMessage(null);

      if (announce) {
        setStatusMessage("Session disconnected.");
        setConnState("disconnected");
      }
    },
    [closeSocketTransport, resetTerminalState]
  );

  const ensureTerminalConnected = useCallback(
    async (
      clearScreen = false,
      userInitiated = false,
      targetAgentId?: string
    ) => {
      if (userInitiated) {
        shouldKeepAttachedRef.current = true;
      }

      const resolvedAgentId = targetAgentId ?? selectedAgentId;
      if (!shouldKeepAttachedRef.current || !resolvedAgentId) return;

      if (
        !userInitiated &&
        reconnectInFlightRef.current?.agentId === resolvedAgentId
      ) {
        await reconnectInFlightRef.current.promise;
        return;
      }

      // Nonce is incremented later (just before opening a new WebSocket) so
      // that reusing a fresh socket doesn't invalidate its existing message
      // handler.  Read the current value here for the in-flight guard only.
      let attemptNonce = attachNonceRef.current;
      const isCurrentAttempt = () =>
        shouldKeepAttachedRef.current &&
        attemptNonce === attachNonceRef.current;

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
          ? (agentsRef.current.find((item) => item.id === resolvedAgentId) ??
            null)
          : null;

        if (!agent || agent.status !== "running") {
          try {
            const payload = await api<{ agent: Agent }>(
              `/api/v1/agents/${resolvedAgentId}?includeGitContext=false`
            );
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
          resetTerminalSurface();
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
        if (
          wsRef.current?.readyState === WebSocket.OPEN &&
          connectedAgentIdRef.current === agent.id
        ) {
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

        if (
          wsRef.current &&
          wsRef.current.readyState === WebSocket.OPEN &&
          connectedAgentIdRef.current === agent.id
        ) {
          closeSocketTransport();
        }

        clearReconnectTimer();
        closeSocket(false);
        resetTerminalSurface();

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
          >(`/api/v1/agents/${agent.id}/terminal/token`, {
            method: "POST",
            body: JSON.stringify({}),
          });

          if (!isCurrentAttempt()) {
            return;
          }

          if (terminalSession.mode === "inert") {
            resetTerminalState();
            restoreConnectedState(agent, "inert", terminalSession.message);
            return;
          }

          const protocol =
            window.location.protocol === "https:" ? "wss:" : "ws:";
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
              try {
                ws.close();
              } catch {}
              return;
            }
            markSocketHealthy("open");
            restoreConnectedState(agent, "tmux");
            focusTerminalSurface(terminalRef.current);
            void queryClient.invalidateQueries({
              queryKey: ["terminal-state", agent.id],
              exact: true,
            });
          });

          ws.addEventListener("message", (event) => {
            if (wsRef.current !== ws || !isCurrentAttempt()) {
              return;
            }
            const payload = JSON.parse(
              String(event.data)
            ) as TerminalSocketMessage;

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
              resetTerminalSurface();
              setConnState("disconnected");
              return;
            }

            if (
              event.code === 1008 &&
              lastErrorMessage &&
              isRetriableTerminalFailure(lastErrorMessage)
            ) {
              scheduleReconnect("Session token expired, retrying...");
              return;
            }

            scheduleReconnect("Session disconnected, reconnecting...");
          });
        } catch (error) {
          if (!isCurrentAttempt()) {
            return;
          }

          const message =
            error instanceof Error
              ? error.message
              : "Session connection failed.";
          if (isTerminalSessionGone(message)) {
            shouldKeepAttachedRef.current = false;
            clearReconnectTimer();
            closeSocket(false);
            resetTerminalSurface();
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

      reconnectInFlightRef.current = {
        agentId: resolvedAgentId,
        promise: connectPromise,
      };
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
      queryClient,
      resetTerminalState,
      resetTerminalSurface,
      restoreConnectedState,
      selectedAgentId,
      sendResize,
    ]
  );

  const detachTerminal = useCallback(() => {
    shouldKeepAttachedRef.current = false;
    invalidateAttachAttempt();
    clearReconnectTimer();
    closeSocket(false);
    resetTerminalSurface();
    setConnState("disconnected");
    setStatusMessage("Detached from session.");
  }, [
    clearReconnectTimer,
    closeSocket,
    invalidateAttachAttempt,
    resetTerminalSurface,
  ]);

  const sendTerminalInput = useCallback((data: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "input", data }));
    terminalRef.current?.focus();
  }, []);

  const noteScrollInteraction = useCallback(() => {
    const agentId = connectedAgentIdRef.current;
    if (
      !copyModeAssistEnabledRef.current ||
      !agentId ||
      terminalMode !== "tmux"
    ) {
      return;
    }
    const now = Date.now();
    if (now - lastInteractionHintAtRef.current < 300) {
      return;
    }
    lastInteractionHintAtRef.current = now;

    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "interaction", interaction: "scroll" }));
      return;
    }

    void api<null>(`/api/v1/agents/${agentId}/terminal/interaction`, {
      method: "POST",
      body: JSON.stringify({ interaction: "scroll" }),
    }).catch(() => {});
  }, [terminalMode]);

  const exitCopyMode = useCallback(async () => {
    const agentId = connectedAgentIdRef.current;
    if (
      !copyModeAssistEnabled ||
      !agentId ||
      terminalMode !== "tmux" ||
      copyMode === "live"
    ) {
      return;
    }

    setExitPending(true);
    copyModeRef.current = "exiting";
    terminalRef.current?.focus();
    requestAnimationFrame(() => {
      terminalRef.current?.focus();
    });
    try {
      await api<null>(`/api/v1/agents/${agentId}/terminal/copy-mode/exit`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    } catch (error) {
      setExitPending(false);
      throw error;
    }
  }, [copyMode, copyModeAssistEnabled, terminalMode]);
  exitCopyModeRef.current = exitCopyMode;
  noteScrollInteractionRef.current = noteScrollInteraction;

  // Keep a ref so the xterm init effect can read the current theme without
  // depending on it (we don't want to re-create the terminal on theme change).
  const themeRef = useRef(theme);
  themeRef.current = theme;

  // xterm initialization.
  useEffect(() => {
    const host = terminalHostElement;
    if (!host) return;

    const isTouchDevice = window.matchMedia("(pointer: coarse)").matches;
    const palette = getTerminalPalette(themeRef.current);
    const term = new XTerm({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily: getTerminalFontFamily(),
      fontSize: 13,
      scrollback: 1000,
      macOptionClickForcesSelection: true,
      screenReaderMode: isTouchDevice,
      minimumContrastRatio: palette.minimumContrastRatio ?? 1,
      theme: palette,
    });

    const fit = new FitAddon();
    const unicode11 = new Unicode11Addon();

    terminalRef.current = term;
    fitAddonRef.current = fit;
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";
    term.loadAddon(fit);
    try {
      term.loadAddon(new ClipboardAddon());
    } catch (e) {
      console.warn("ClipboardAddon failed:", e);
    }
    term.open(host);
    fit.fit();

    const handleCopy = (e: ClipboardEvent) => {
      if (term.hasSelection()) {
        e.preventDefault();
        e.stopPropagation();
        e.clipboardData?.setData(
          "text/plain",
          cleanCopiedText(term.getSelection())
        );
      }
    };
    host.addEventListener("copy", handleCopy, true);

    // Upload a clipboard image to the host pasteboard, then send Ctrl+V so CLI
    // tools read it natively. This bridges the browser clipboard to the server.
    const syncClipboardImage = (blob: File): void => {
      const form = new FormData();
      form.append(
        "file",
        blob,
        `clipboard.${blob.type === "image/png" ? "png" : "jpg"}`
      );
      fetch("/api/v1/clipboard/image", {
        method: "POST",
        body: form,
        credentials: "include",
      })
        .then((res) => {
          if (!res.ok) throw new Error(`clipboard upload: ${res.status}`);
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "input", data: "\x16" }));
          }
        })
        .catch((err) => console.warn("Clipboard image paste failed:", err));
    };

    // Intercept paste events (Cmd+V) — clipboard data is available directly.
    const handlePaste = (e: ClipboardEvent) => {
      const imageItem = Array.from(e.clipboardData?.items ?? []).find((item) =>
        item.type.startsWith("image/")
      );
      if (!imageItem) return; // no image — let xterm handle text paste normally
      const blob = imageItem.getAsFile();
      if (!blob) return;
      e.preventDefault();
      e.stopPropagation();
      syncClipboardImage(blob);
    };
    host.addEventListener("paste", handlePaste, true);

    const screenEl = host.querySelector(".xterm-screen") as HTMLElement | null;
    let touchY = 0;
    let touchAccum = 0;
    const TOUCH_SCROLL_SENSITIVITY_PX = 30;
    // ⚠️ CRITICAL — DO NOT add a copyModeAssistEnabled (or similar)
    // gate to these touch handlers. Tmux scroll on mobile is critical
    // functionality and is independent of the assist toggle.
    //
    // xterm has no native touch handling, so this synthesis is the ONLY
    // path that makes touch scroll work at all. tmux mouse mode is
    // enabled unconditionally at session launch (see
    // apps/server/src/agents/tmux/runtime.ts), so the synthetic wheel
    // events are forwarded to tmux as SGR mouse codes regardless of the
    // toggle. The toggle controls *only* the banner UI / the passive
    // copy-mode observer. PR #459 originally tied this synthesis to the
    // toggle and silently killed scroll for everyone with the toggle
    // off — do not repeat that mistake.
    const onTouchStart = (e: TouchEvent) => {
      if (!isTouchDevice || e.touches.length !== 1) return;
      touchY = e.touches[0].clientY;
      touchAccum = 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!isTouchDevice || e.touches.length !== 1) return;
      if (!screenEl) return;
      const currentY = e.touches[0].clientY;
      const delta = touchY - currentY;
      touchY = currentY;
      touchAccum += delta;
      while (Math.abs(touchAccum) >= TOUCH_SCROLL_SENSITIVITY_PX) {
        const direction = touchAccum > 0 ? 1 : -1;
        touchAccum -= direction * TOUCH_SCROLL_SENSITIVITY_PX;
        screenEl.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: direction * 100,
            deltaMode: 0,
            bubbles: true,
            cancelable: true,
          })
        );
      }
    };
    // On touch devices, xterm's text-selection mousedown handler doesn't
    // fire from a real touch tap. Re-dispatch with shift+alt set so xterm
    // treats the tap as the start of a selection, which in turn focuses
    // the screen so subsequent input events route correctly.
    let dispatchingMouseDown = false;
    const onMouseDown = (e: MouseEvent) => {
      if (dispatchingMouseDown) return;
      if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey)
        return;
      e.stopPropagation();
      e.preventDefault();
      dispatchingMouseDown = true;
      (e.target as HTMLElement).dispatchEvent(
        new MouseEvent("mousedown", {
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
        })
      );
      dispatchingMouseDown = false;
    };

    // Intercept right-click (button 2) before xterm forwards it to tmux
    // as an SGR mouse event, which triggers tmux's display-menu. Stopping
    // propagation here keeps the browser's native contextmenu event intact
    // so the user gets the standard copy/paste menu without a tmux menu
    // overlapping it. Focus xterm's textarea so native Paste targets it.
    const onRightMouseDown = (e: MouseEvent) => {
      if (e.button !== 2) return;
      e.stopPropagation();
      const textarea = host.querySelector(
        "textarea.xterm-helper-textarea"
      ) as HTMLTextAreaElement | null;
      if (textarea) textarea.focus();
    };
    host.addEventListener("mousedown", onRightMouseDown, true);

    host.addEventListener("touchstart", onTouchStart, { passive: true });
    host.addEventListener("touchmove", onTouchMove, { passive: true });
    const onWheel = () => noteScrollInteractionRef.current();
    if (screenEl) {
      screenEl.addEventListener("mousedown", onMouseDown, true);
      screenEl.addEventListener("wheel", onWheel, { passive: true });
    }

    const disposable = term.onData((data) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (ctrlPendingRef.current && data.length === 1) {
        const code = data.toUpperCase().charCodeAt(0);
        if (code >= 65 && code <= 90) {
          ctrlPendingRef.current = false;
          window.dispatchEvent(new Event("ctrl-consumed"));
          ws.send(
            JSON.stringify({
              type: "input",
              data: String.fromCharCode(code - 64),
            })
          );
          return;
        }
      }
      ws.send(JSON.stringify({ type: "input", data }));
    });

    const onResize = () => {
      if (deferMediaResizeRef.current) return;
      requestFit();
    };

    window.addEventListener("resize", onResize);

    // ResizeObserver so the terminal reflows when its container changes size
    // (e.g. feedback panel opening/closing via CSS grid transition).
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(host);

    return () => {
      invalidateAttachAttempt();
      if (fitDebounceRef.current !== null) {
        window.clearTimeout(fitDebounceRef.current);
        fitDebounceRef.current = null;
      }
      disposable.dispose();
      resizeObserver.disconnect();
      host.removeEventListener("copy", handleCopy, true);
      host.removeEventListener("paste", handlePaste, true);
      host.removeEventListener("mousedown", onRightMouseDown, true);
      host.removeEventListener("touchstart", onTouchStart);
      host.removeEventListener("touchmove", onTouchMove);
      if (screenEl) {
        screenEl.removeEventListener("mousedown", onMouseDown, true);
        screenEl.removeEventListener("wheel", onWheel);
      }
      window.removeEventListener("resize", onResize);
      try {
        wsRef.current?.close();
      } catch {}
      wsRef.current = null;
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [authState, invalidateAttachAttempt, requestFit, terminalHostElement]);

  // Reconnect on visibility/focus.
  useEffect(() => {
    if (
      terminalMode !== "tmux" ||
      serverCopyMode === "live" ||
      serverCopyMode === "copy"
    ) {
      setExitPending(false);
    }
  }, [serverCopyMode, terminalMode]);

  useEffect(() => {
    const requestForegroundReconnect = () => {
      const targetAgentId =
        connectedAgentIdRef.current ?? selectedAgentId ?? undefined;
      if (!targetAgentId) return;
      if (hasFreshSocket(targetAgentId)) return;
      const now = Date.now();
      if (now - lastResumeTriggerAtRef.current < RESUME_RECONNECT_DEDUPE_MS) {
        return;
      }
      lastResumeTriggerAtRef.current = now;
      void ensureTerminalConnected(false, false, targetAgentId);
    };

    // Re-focus the terminal when the window/tab is foregrounded so the user
    // can type immediately. Gated to avoid stealing focus from other inputs
    // (dialogs, search, sidebar fields) that the browser may have restored.
    const tryFocusTerminalOnForeground = () => {
      const term = terminalRef.current;
      const host = terminalHostRef.current;
      if (!term || !host) return;
      if (terminalMode !== "tmux") return;
      if (isMobile) return;
      if (copyModeRef.current === "copy") return;
      const active = document.activeElement;
      // Treat body / documentElement / null as "nothing else holds focus" —
      // some browsers report the root element instead of body when no
      // interactive control owns focus after the window is foregrounded.
      const focusElsewhere =
        active &&
        active !== document.body &&
        active !== document.documentElement &&
        !host.contains(active);
      if (focusElsewhere) return;
      focusTerminalSurface(term);
    };

    const onVisible = () => {
      if (!document.hidden) {
        requestForegroundReconnect();
        tryFocusTerminalOnForeground();
      }
    };

    const onFocus = () => {
      requestForegroundReconnect();
      tryFocusTerminalOnForeground();
    };

    const onOnline = () => {
      clearReconnectTimer();
      void ensureTerminalConnected(
        false,
        false,
        connectedAgentIdRef.current ?? selectedAgentId ?? undefined
      );
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
    };
  }, [
    clearReconnectTimer,
    ensureTerminalConnected,
    hasFreshSocket,
    isMobile,
    selectedAgentId,
    terminalMode,
  ]);

  // Fit on layout change. The actual fit is debounced and reads the host's
  // settled size, so we don't need a hand-tuned timer to "wait for" the CSS
  // transition — ResizeObserver will keep poking requestFit until it stops.
  useEffect(() => {
    if (isMobile) return;
    requestFit();
  }, [isMobile, leftOpen, feedbackOpen, requestFit]);

  // Media sidebar width animates; the deferMediaResize gate suppresses
  // ResizeObserver fits during the slide, then this effect kicks one off
  // once it settles.
  useEffect(() => {
    if (isMobile) return;
    if (deferMediaResize) return;
    requestFit();
  }, [deferMediaResize, isMobile, mediaResizeSettleKey, requestFit]);

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
  }, [
    theme,
    connState,
    connectedAgentId,
    detachTerminal,
    ensureTerminalConnected,
  ]);

  const focusTerminal = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  // Wire requestFit's auto-RESYNC trigger to the actual detach/reconnect
  // pair now that they exist. Mirrors the manual RESYNC button flow.
  useEffect(() => {
    resyncOnResizeRef.current = () => {
      const agentId = connectedAgentIdRef.current;
      if (!agentId) return;
      setResyncing(true);
      detachTerminal();
      window.setTimeout(() => {
        void ensureTerminalConnected(true, true, agentId);
      }, 150);
    };
  }, [detachTerminal, ensureTerminalConnected]);

  // Clear the resyncing flag once the new attach lands.
  useEffect(() => {
    if (resyncing && connState === "connected") {
      setResyncing(false);
    }
  }, [resyncing, connState]);

  return useMemo(
    () => ({
      connState,
      connectedAgentId,
      terminalMode,
      terminalPlaceholderMessage,
      inCopyMode: copyMode === "copy" || copyMode === "exiting",
      copyMode,
      statusMessage,
      terminalHostRef: setTerminalHostRef,
      ctrlPendingRef,
      focusTerminal,
      ensureTerminalConnected,
      detachTerminal,
      sendTerminalInput,
      exitCopyMode,
      setTerminalHostRef,
      resyncing,
    }),
    [
      connState,
      copyMode,
      connectedAgentId,
      terminalMode,
      terminalPlaceholderMessage,
      statusMessage,
      focusTerminal,
      ensureTerminalConnected,
      detachTerminal,
      sendTerminalInput,
      exitCopyMode,
      setTerminalHostRef,
      resyncing,
    ]
  );
}
