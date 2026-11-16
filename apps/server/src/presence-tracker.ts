/**
 * In-memory app presence: which browser sessions (a tab or installed PWA, on
 * any device) are open in Dispatch and in use. Built only from coarse
 * signals the server already sees — never from input events:
 *
 * - the focus heartbeat: whether the session is visible and focused, and
 *   whether the beat came from the user acting (focusing the window, showing
 *   the tab, changing route);
 * - chat actions the session sends (posting, answering, submitting a form),
 *   which call `noteActivity`.
 *
 * State is ephemeral like FocusTracker's — a server restart forgets every
 * session, which falls back to "away" until the next heartbeat.
 */

/** A session that hasn't heartbeat in this long is gone (closed, asleep, offline). */
export const PRESENCE_TTL_MS = 45_000;
/** A session the user acted in this recently stays present while unfocused. */
export const PRESENCE_ACTIVITY_WINDOW_MS = 5 * 60_000;
/** The request header that names the app session a request came from. */
export const PRESENCE_SESSION_HEADER = "x-dispatch-session";

export type PresenceHeartbeat = {
  visible: boolean;
  focused: boolean;
  /** The agent the session is showing, or null when it shows none. */
  viewingAgentId: string | null;
  /** The beat was sent because the user did something (focus, show, navigate). */
  active?: boolean;
};

export type PresenceSession = Omit<PresenceHeartbeat, "active"> & {
  sessionId: string;
  /** Server-clock time of the last heartbeat. */
  lastSeenAt: number;
  /** Server-clock time the user last did something in this session. */
  lastActiveAt: number | null;
};

export class PresenceTracker {
  private sessions = new Map<string, PresenceSession>();

  constructor(private now: () => number = Date.now) {}

  heartbeat(sessionId: string, beat: PresenceHeartbeat): void {
    const now = this.now();
    const previous = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      sessionId,
      visible: beat.visible,
      focused: beat.focused,
      viewingAgentId: beat.viewingAgentId,
      lastSeenAt: now,
      lastActiveAt: beat.active ? now : (previous?.lastActiveAt ?? null),
    });
    this.prune(now);
  }

  /** The user did something in this session (a request only a person makes). */
  noteActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.lastActiveAt = this.now();
  }

  /** Forget a session, e.g. one that closed. */
  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Forget sessions that stopped heartbeating. */
  private prune(now: number): void {
    for (const [id, session] of this.sessions) {
      if (now - session.lastSeenAt > PRESENCE_TTL_MS) this.sessions.delete(id);
    }
  }

  /** Present sessions: visible and focused, or acted in within the activity window. */
  activeSessions(): PresenceSession[] {
    const now = this.now();
    this.prune(now);
    return [...this.sessions.values()]
      .filter(
        (session) =>
          (session.visible && session.focused) ||
          (session.lastActiveAt !== null &&
            now - session.lastActiveAt <= PRESENCE_ACTIVITY_WINDOW_MS)
      )
      .map((session) => ({ ...session }));
  }

  /** How many sessions are tracked, expired ones included until pruned. */
  get size(): number {
    return this.sessions.size;
  }

  /** True while any session is present. */
  isPresent(): boolean {
    return this.activeSessions().length > 0;
  }
}

/**
 * Present sessions that should get an in-app toast about this agent: every
 * one except those looking at it right now (showing it, visible and focused).
 * A window showing the agent behind another app still gets the toast.
 */
export function toastRecipients(
  sessions: PresenceSession[],
  agentId: string
): string[] {
  return sessions
    .filter(
      (session) =>
        !(
          session.viewingAgentId === agentId &&
          session.visible &&
          session.focused
        )
    )
    .map((session) => session.sessionId);
}

/** Chat writes the client sends on its own (read receipts), not the user acting. */
const AUTOMATIC_STREAM_WRITES = new Set([
  "/api/v1/streams/:rootId/read",
  "/api/v1/streams/:rootId/blocks/:blockId/read",
]);

/**
 * Whether a request (by method and route pattern) is the user doing
 * something in chat: posting, answering a question, submitting a form,
 * reacting, retrying. Reads never count — feeds and threads refetch on
 * their own whenever an agent posts — and opening a chat already sends an
 * active focus beat.
 */
export function isActivityRequest(method: string, route: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS")
    return false;
  return (
    route.startsWith("/api/v1/streams/") && !AUTOMATIC_STREAM_WRITES.has(route)
  );
}
