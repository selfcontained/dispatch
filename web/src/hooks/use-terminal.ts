import { type MutableRefObject, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { type Agent, type AuthState, type ConnState } from "@/components/app/types";
import { api } from "@/lib/api";
import { recordWSReconnect } from "@/lib/energy-metrics";

const ACTIVE_SHELL_AGENT_KEY = "dispatch:activeShellAgentId";

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

/** Read a CSS custom property as an hsl() hex string. */
function cssHsl(prop: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(prop).trim();
  if (!raw) return "";
  // raw is like "0 0% 8%" — convert to hsl(0, 0%, 8%) then to hex via a temp element
  const el = document.createElement("div");
  el.style.color = `hsl(${raw.replace(/ /g, ", ")})`;
  document.body.appendChild(el);
  const computed = getComputedStyle(el).color;
  el.remove();
  // computed is rgb(r, g, b), convert to hex
  const match = computed.match(/(\d+)/g);
  if (!match || match.length < 3) return "";
  return "#" + match.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
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
  ensureTerminalConnected: (clearScreen?: boolean, userInitiated?: boolean, targetAgentId?: string) => Promise<void>;
  detachTerminal: () => void;
  sendTerminalInput: (data: string) => void;
} {
  const {
    authState,
    agents,
    agentsLoaded,
    selectedAgentId,
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

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const invalidateAttachAttempt = useCallback(() => {
    attachNonceRef.current += 1;
  }, []);

  const closeSocket = useCallback((announce = true) => {
    if (wsRef.current) {
      try { wsRef.current.close(); } catch {}
      wsRef.current = null;
    }
    setConnectedAgentId(null);
    setTerminalMode(null);
    setTerminalPlaceholderMessage(null);

    if (announce) {
      setStatusMessage("Session disconnected.");
      setConnState("disconnected");
    }
  }, []);

  const ensureTerminalConnected = useCallback(
    async (clearScreen = false, userInitiated = false, targetAgentId?: string) => {
      if (userInitiated) {
        shouldKeepAttachedRef.current = true;
      }

      const resolvedAgentId = targetAgentId ?? selectedAgentId;
      if (!shouldKeepAttachedRef.current || !resolvedAgentId) return;

      let agent: Agent | null = userInitiated
        ? (agentsRef.current.find((item) => item.id === resolvedAgentId) ?? null)
        : null;

      if (!agent || agent.status !== "running") {
        try {
          const payload = await api<{ agent: Agent }>(`/api/v1/agents/${resolvedAgentId}?includeGitContext=false`);
          agent = payload.agent;
        } catch {
          if (!shouldKeepAttachedRef.current) return;
          clearReconnectTimer();
          reconnectAttemptsRef.current += 1;
          recordWSReconnect();
          const delay = Math.min(1200 * reconnectAttemptsRef.current, 8000);
          setConnState("reconnecting");
          setStatusMessage("Session disconnected, reconnecting...");
          reconnectTimerRef.current = window.setTimeout(() => {
            reconnectTimerRef.current = null;
            if (document.hidden) return;
            void ensureTerminalConnected(false, false, resolvedAgentId);
          }, delay);
          return;
        }
        if (!shouldKeepAttachedRef.current) return;
      }

      if (agent.status !== "running") {
        setConnState("disconnected");
        return;
      }

      // If already connected to this agent, just resize — don't invalidate the
      // current attach nonce, which would cause the existing WS message handler
      // to silently drop all incoming output.
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        if (connectedAgentIdRef.current === agent.id) {
          sendResize();
          return;
        }
      }

      // We're actually establishing a new connection — now invalidate prior attempts.
      const attachNonce = ++attachNonceRef.current;
      const isCurrentAttempt = () =>
        shouldKeepAttachedRef.current && attachNonce === attachNonceRef.current;

      clearReconnectTimer();
      closeSocket(false);

      if (clearScreen) {
        terminalRef.current?.clear();
      }

      fitAddonRef.current?.fit();
      setConnState("reconnecting");
      setStatusMessage(`Connecting to session ${agent.name}...`);

      const scheduleReconnect = (message: string) => {
        if (!isCurrentAttempt()) {
          setConnState("disconnected");
          return;
        }

        reconnectAttemptsRef.current += 1;
        recordWSReconnect();
        const delay = Math.min(1200 * reconnectAttemptsRef.current, 8000);
        setConnState("reconnecting");
        setStatusMessage(message);

        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          if (document.hidden) return;
          void ensureTerminalConnected(false, false, resolvedAgentId);
        }, delay);
      };

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
          reconnectAttemptsRef.current = 0;
          setConnState("connected");
          setConnectedAgentId(agent.id);
          setTerminalMode("inert");
          setTerminalPlaceholderMessage(terminalSession.message);
          setStatusMessage(terminalSession.message);
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
          reconnectAttemptsRef.current = 0;
          setConnState("connected");
          setConnectedAgentId(agent.id);
          setStatusMessage(`Connected to session ${agent.name}`);
          terminalRef.current?.focus();
        });

        ws.addEventListener("message", (event) => {
          if (wsRef.current !== ws || !isCurrentAttempt()) {
            return;
          }
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
          if (wsRef.current !== ws || !isCurrentAttempt()) return;
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
    [clearReconnectTimer, closeSocket, selectedAgentId, sendResize]
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

  // xterm initialization.
  useEffect(() => {
    const host = terminalHostRef.current;
    if (!host) return;

    const isTouchDevice = window.matchMedia("(pointer: coarse)").matches;

    const term = new XTerm({
      convertEol: false,
      cursorBlink: true,
      fontFamily: "JetBrains Mono, Menlo, monospace",
      fontSize: 13,
      scrollback: 1000,
      macOptionClickForcesSelection: true,
      screenReaderMode: isTouchDevice,
      theme: {
        foreground: cssHsl("--foreground") || "#f8f8f2",
        background: cssHsl("--terminal-bg") || "#141414",
        cursor: "#f8f8f0",
        cursorAccent: cssHsl("--terminal-bg") || "#141414",
        selectionBackground: "#49483e",
        selectionInactiveBackground: "#3e3d32",
        black: cssHsl("--terminal-bg") || "#141414",
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
        brightWhite: "#f9f8f5",
      },
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
    const onVisible = () => {
      if (!document.hidden) {
        void ensureTerminalConnected(false, false, connectedAgentIdRef.current ?? selectedAgentId ?? undefined);
      }
    };

    const onFocus = () => {
      void ensureTerminalConnected(false, false, connectedAgentIdRef.current ?? selectedAgentId ?? undefined);
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [connectedAgentId, ensureTerminalConnected, selectedAgentId]);

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


  return useMemo(() => ({
    connState,
    connectedAgentId,
    terminalMode,
    terminalPlaceholderMessage,
    statusMessage,
    terminalHostRef: terminalHostRef as RefObject<HTMLDivElement>,
    ctrlPendingRef,
    ensureTerminalConnected,
    detachTerminal,
    sendTerminalInput,
  }), [
    connState,
    connectedAgentId,
    terminalMode,
    terminalPlaceholderMessage,
    statusMessage,
    ensureTerminalConnected,
    detachTerminal,
    sendTerminalInput,
  ]);
}
