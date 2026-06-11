import type { MutableRefObject } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { Agent, ConnState } from "@/components/app/types";
import { api } from "@/lib/api";
import { recordWSReconnect } from "@/lib/energy-metrics";
import {
  type SocketHealth,
  clearSocketHealth,
  isRetriableTerminalFailure,
  isTerminalSessionGone,
  markSocketHealthy,
  noteSocketError,
  openTerminalSocket,
} from "@/hooks/terminal-socket";

export interface TerminalConnectRefs {
  shouldKeepAttachedRef: MutableRefObject<boolean>;
  reconnectInFlightRef: MutableRefObject<{
    agentId: string;
    promise: Promise<void>;
  } | null>;
  attachNonceRef: MutableRefObject<number>;
  agentsRef: MutableRefObject<Agent[]>;
  reconnectAttemptsRef: MutableRefObject<number>;
  reconnectTimerRef: MutableRefObject<number | null>;
  wsRef: MutableRefObject<WebSocket | null>;
  connectedAgentIdRef: MutableRefObject<string | null>;
  terminalRef: MutableRefObject<XTerm | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  socketHealthRef: MutableRefObject<SocketHealth>;
  reconnectRef: MutableRefObject<
    (
      clearScreen: boolean,
      userInitiated: boolean,
      targetAgentId?: string
    ) => Promise<void>
  >;
}

export interface TerminalConnectCallbacks {
  selectedAgentId: string | null;
  queryClient: QueryClient;
  clearReconnectTimer: () => void;
  closeSocket: (announce?: boolean) => void;
  closeSocketTransport: () => void;
  hasFreshSocket: (agentId: string) => boolean;
  probeSocket: (agentId: string) => Promise<boolean>;
  resetTerminalState: () => void;
  resetTerminalSurface: () => void;
  restoreConnectedState: (
    agent: Agent,
    mode: "tmux" | "inert",
    message?: string
  ) => void;
  sendResize: () => void;
  focusTerminalSurface: (term: XTerm | null) => void;
  setConnState: (state: ConnState) => void;
  setConnectedAgentId: (id: string | null) => void;
  setTerminalMode: (mode: "tmux" | "inert" | null) => void;
  setTerminalPlaceholderMessage: (msg: string | null) => void;
  setStatusMessage: (msg: string) => void;
}

export async function connectTerminal(
  refs: TerminalConnectRefs,
  cbs: TerminalConnectCallbacks,
  clearScreen: boolean,
  userInitiated: boolean,
  targetAgentId?: string
): Promise<void> {
  if (userInitiated) {
    refs.shouldKeepAttachedRef.current = true;
  }

  const resolvedAgentId = targetAgentId ?? cbs.selectedAgentId;
  if (!refs.shouldKeepAttachedRef.current || !resolvedAgentId) return;

  if (
    !userInitiated &&
    refs.reconnectInFlightRef.current?.agentId === resolvedAgentId
  ) {
    await refs.reconnectInFlightRef.current.promise;
    return;
  }

  let attemptNonce = refs.attachNonceRef.current;
  const isCurrentAttempt = () =>
    refs.shouldKeepAttachedRef.current &&
    attemptNonce === refs.attachNonceRef.current;

  const scheduleReconnect = (message: string) => {
    if (!isCurrentAttempt() || !refs.shouldKeepAttachedRef.current) {
      return;
    }

    refs.reconnectAttemptsRef.current += 1;
    recordWSReconnect();
    const delay = Math.min(1200 * refs.reconnectAttemptsRef.current, 8000);
    cbs.setConnState("reconnecting");
    cbs.setStatusMessage(message);
    cbs.clearReconnectTimer();
    refs.reconnectTimerRef.current = window.setTimeout(() => {
      refs.reconnectTimerRef.current = null;
      if (!refs.shouldKeepAttachedRef.current || document.hidden) return;
      void refs.reconnectRef.current(false, false, resolvedAgentId);
    }, delay);
  };

  const connectPromise = (async () => {
    let agent: Agent | null = userInitiated
      ? (refs.agentsRef.current.find((item) => item.id === resolvedAgentId) ??
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
      refs.shouldKeepAttachedRef.current = false;
      cbs.clearReconnectTimer();
      cbs.closeSocket(false);
      cbs.resetTerminalSurface();
      cbs.setConnState("disconnected");
      cbs.setStatusMessage("Session ended.");
      return;
    }

    if (cbs.hasFreshSocket(agent.id)) {
      cbs.restoreConnectedState(agent, "tmux");
      cbs.sendResize();
      return;
    }

    if (
      refs.wsRef.current?.readyState === WebSocket.OPEN &&
      refs.connectedAgentIdRef.current === agent.id
    ) {
      const alive = await cbs.probeSocket(agent.id);
      if (!isCurrentAttempt()) return;
      if (alive) {
        cbs.restoreConnectedState(agent, "tmux");
        cbs.sendResize();
        return;
      }
    }

    attemptNonce = ++refs.attachNonceRef.current;

    if (
      refs.wsRef.current &&
      refs.wsRef.current.readyState === WebSocket.OPEN &&
      refs.connectedAgentIdRef.current === agent.id
    ) {
      cbs.closeSocketTransport();
    }

    cbs.clearReconnectTimer();
    cbs.closeSocket(false);
    cbs.resetTerminalSurface();

    if (clearScreen) {
      refs.terminalRef.current?.clear();
    }

    refs.fitAddonRef.current?.fit();
    cbs.setConnState("reconnecting");
    cbs.setStatusMessage(`Connecting to session ${agent.name}...`);

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
        cbs.resetTerminalState();
        cbs.restoreConnectedState(agent, "inert", terminalSession.message);
        return;
      }

      const term = refs.terminalRef.current;
      const cols = term?.cols ?? 140;
      const rows = term?.rows ?? 42;
      cbs.setTerminalMode("tmux");
      cbs.setTerminalPlaceholderMessage(null);
      const ws = openTerminalSocket(
        terminalSession.wsUrl,
        cols,
        rows,
        {
          onOpen: () => {
            markSocketHealthy(refs.socketHealthRef.current, "open");
            cbs.restoreConnectedState(agent, "tmux");
            cbs.focusTerminalSurface(refs.terminalRef.current);
            void cbs.queryClient.invalidateQueries({
              queryKey: ["terminal-state", agent.id],
              exact: true,
            });
          },
          onHeartbeat: () =>
            markSocketHealthy(refs.socketHealthRef.current, "heartbeat"),
          onOutput: (data) => {
            markSocketHealthy(refs.socketHealthRef.current, "output");
            refs.terminalRef.current?.write(data);
          },
          onError: (message) => {
            noteSocketError(refs.socketHealthRef.current, message);
            cbs.setStatusMessage(`Session error: ${message}`);
            if (isTerminalSessionGone(message)) {
              refs.shouldKeepAttachedRef.current = false;
            }
          },
          onSessionEnd: () => {
            noteSocketError(refs.socketHealthRef.current, "Session ended.");
            refs.socketHealthRef.current.sessionGone = true;
            refs.shouldKeepAttachedRef.current = false;
            cbs.setStatusMessage("Session ended.");
          },
          onClose: (event) => {
            refs.wsRef.current = null;
            const lastErrorMessage =
              refs.socketHealthRef.current.lastErrorMessage;
            const sessionGone = refs.socketHealthRef.current.sessionGone;
            clearSocketHealth(refs.socketHealthRef.current);

            if (sessionGone) {
              refs.shouldKeepAttachedRef.current = false;
              cbs.setConnectedAgentId(null);
              cbs.setTerminalMode(null);
              cbs.resetTerminalSurface();
              cbs.setConnState("disconnected");
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
          },
        },
        () => refs.wsRef.current !== ws || !isCurrentAttempt()
      );
      refs.wsRef.current = ws;
    } catch (error) {
      if (!isCurrentAttempt()) {
        return;
      }

      const message =
        error instanceof Error ? error.message : "Session connection failed.";
      if (isTerminalSessionGone(message)) {
        refs.shouldKeepAttachedRef.current = false;
        cbs.clearReconnectTimer();
        cbs.closeSocket(false);
        cbs.resetTerminalSurface();
        cbs.setConnState("disconnected");
        cbs.setStatusMessage(message);
        return;
      }

      scheduleReconnect(
        isRetriableTerminalFailure(message)
          ? "Session token expired, retrying..."
          : "Session connection failed, retrying..."
      );
    }
  })();

  refs.reconnectInFlightRef.current = {
    agentId: resolvedAgentId,
    promise: connectPromise,
  };
  try {
    await connectPromise;
  } finally {
    if (refs.reconnectInFlightRef.current?.promise === connectPromise) {
      refs.reconnectInFlightRef.current = null;
    }
  }
}
