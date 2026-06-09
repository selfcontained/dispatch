export const TERMINAL_HEARTBEAT_INTERVAL_MS = 20_000;
export const TERMINAL_LIVENESS_GRACE_MS = 5_000;
export const TERMINAL_FRESHNESS_MS =
  TERMINAL_HEARTBEAT_INTERVAL_MS + TERMINAL_LIVENESS_GRACE_MS;
export const RESUME_RECONNECT_DEDUPE_MS = 150;
export const SOCKET_PROBE_TIMEOUT_MS = 1_500;

export type TerminalSocketMessage =
  | { type: "heartbeat"; ts: number }
  | { type: "output"; data: string }
  | { type: "error"; message: string }
  | { type: "exit"; exitCode?: number };

export function isTerminalSessionGone(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("session no longer exists") ||
    normalized.includes("session is not available") ||
    normalized.includes("tmux session is no longer running")
  );
}

export function isRetriableTerminalFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("invalid or expired terminal token") ||
    normalized.includes("attach failed")
  );
}

export interface SocketHealth {
  lastHeartbeatAt: number;
  lastOutputAt: number;
  lastHealthyAt: number;
  lastOpenAt: number;
  lastErrorMessage: string | null;
  sessionGone: boolean;
}

export function createSocketHealth(): SocketHealth {
  return {
    lastHeartbeatAt: 0,
    lastOutputAt: 0,
    lastHealthyAt: 0,
    lastOpenAt: 0,
    lastErrorMessage: null,
    sessionGone: false,
  };
}

export function markSocketHealthy(
  health: SocketHealth,
  source: "open" | "heartbeat" | "output"
): void {
  const now = Date.now();
  if (source === "open") {
    health.lastOpenAt = now;
  } else if (source === "heartbeat") {
    health.lastHeartbeatAt = now;
  } else {
    health.lastOutputAt = now;
  }
  health.lastHealthyAt = now;
  health.lastErrorMessage = null;
  health.sessionGone = false;
}

export function noteSocketError(health: SocketHealth, message: string): void {
  health.lastErrorMessage = message;
  health.sessionGone = isTerminalSessionGone(message);
}

export function clearSocketHealth(health: SocketHealth): void {
  health.lastHeartbeatAt = 0;
  health.lastOutputAt = 0;
  health.lastHealthyAt = 0;
  health.lastOpenAt = 0;
  health.lastErrorMessage = null;
  health.sessionGone = false;
}

export function isSocketFresh(health: SocketHealth): boolean {
  return Date.now() - health.lastHealthyAt <= TERMINAL_FRESHNESS_MS;
}

export function probeTerminalSocket(
  ws: WebSocket,
  cols: number,
  rows: number,
  onHealthy: () => void,
  timeout = SOCKET_PROBE_TIMEOUT_MS
): Promise<boolean> {
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
      onHealthy();
      settle(true);
    };
    const onClose = () => settle(false);
    const timer = setTimeout(() => settle(false), timeout);

    ws.addEventListener("message", onMsg);
    ws.addEventListener("close", onClose);
    ws.send(JSON.stringify({ type: "resize", cols, rows }));
  });
}

export interface TerminalSocketEvents {
  onOpen: () => void;
  onHeartbeat: () => void;
  onOutput: (data: string) => void;
  onError: (message: string) => void;
  onSessionEnd: () => void;
  onClose: (event: CloseEvent) => void;
}

export function openTerminalSocket(
  wsUrl: string,
  cols: number,
  rows: number,
  events: TerminalSocketEvents,
  isStale: () => boolean
): WebSocket {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(
    `${protocol}//${window.location.host}${wsUrl}&cols=${cols}&rows=${rows}`
  );

  ws.addEventListener("open", () => {
    if (isStale()) {
      try {
        ws.close();
      } catch {}
      return;
    }
    events.onOpen();
  });

  ws.addEventListener("message", (event) => {
    if (isStale()) return;
    const payload = JSON.parse(String(event.data)) as TerminalSocketMessage;

    if (payload.type === "heartbeat") {
      events.onHeartbeat();
      return;
    }
    if (payload.type === "output") {
      events.onOutput(payload.data);
      return;
    }
    if (payload.type === "error") {
      events.onError(payload.message);
      return;
    }
    events.onSessionEnd();
  });

  ws.addEventListener("close", (event) => {
    if (isStale()) return;
    events.onClose(event);
  });

  return ws;
}
