/**
 * In-memory app presence: which browser sessions (a tab or installed PWA, on
 * any device) are open in Dispatch, visible, and recently used. Each session
 * heartbeats its visibility, idle time and the agent it is viewing. State is
 * ephemeral like FocusTracker's — a server restart forgets every session,
 * which falls back to "not present" until the next heartbeat.
 */

/** A session that hasn't heartbeat in this long is gone (closed, asleep, offline). */
export const PRESENCE_TTL_MS = 45_000;
/** A visible session counts as active while its last interaction is this recent. */
export const PRESENCE_ACTIVE_WINDOW_MS = 120_000;

export type PresenceHeartbeat = {
  visible: boolean;
  /** Milliseconds since the session's last interaction, by its own clock. */
  idleMs: number;
  /** The agent the session is showing, or null when it shows none. */
  viewingAgentId: string | null;
};

export type PresenceSession = {
  sessionId: string;
  visible: boolean;
  /** Server-clock time of the last interaction. */
  lastInteractionAt: number;
  /** Server-clock time of the last heartbeat. */
  lastSeenAt: number;
  viewingAgentId: string | null;
};

export class PresenceTracker {
  private sessions = new Map<string, PresenceSession>();

  constructor(private now: () => number = Date.now) {}

  heartbeat(sessionId: string, beat: PresenceHeartbeat): void {
    const now = this.now();
    // Idle time, not a timestamp: devices' clocks disagree with the server's.
    const idleMs = Math.max(0, beat.idleMs);
    this.sessions.set(sessionId, {
      sessionId,
      visible: beat.visible,
      lastInteractionAt: now - idleMs,
      lastSeenAt: now,
      viewingAgentId: beat.viewingAgentId,
    });
  }

  /** The session closed (tab unloaded). */
  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Visible sessions with an interaction inside the active window. */
  activeSessions(): PresenceSession[] {
    const now = this.now();
    const active: PresenceSession[] = [];
    for (const [id, session] of this.sessions) {
      if (now - session.lastSeenAt > PRESENCE_TTL_MS) {
        this.sessions.delete(id);
        continue;
      }
      if (
        session.visible &&
        now - session.lastInteractionAt <= PRESENCE_ACTIVE_WINDOW_MS
      ) {
        active.push({ ...session });
      }
    }
    return active;
  }

  /** True while any session is active. */
  isPresent(): boolean {
    return this.activeSessions().length > 0;
  }
}

/** Active sessions that should get an in-app toast about this agent: every one not already viewing it. */
export function toastRecipients(
  sessions: PresenceSession[],
  agentId: string
): string[] {
  return sessions
    .filter((session) => session.viewingAgentId !== agentId)
    .map((session) => session.sessionId);
}
