/**
 * In-memory tracker for which agents the user is actively viewing in the UI.
 * Used to suppress redundant Slack notifications when the user is already
 * looking at the agent. State is ephemeral — server restart clears all focus,
 * which is the safe default (notifications resume).
 */

const FOCUS_TTL_MS = 30_000;

export class FocusTracker {
  private focusedAgents = new Map<string, number>();

  /**
   * Browser notification permission reported by the client via focus heartbeat.
   * Mirrors the browser's NotificationPermission: "default" | "granted" | "denied".
   * Defaults to "default" (not granted) — safe default means Slack is not suppressed
   * until the client explicitly reports "granted".
   */
  private webNotifyPermission: "default" | "granted" | "denied" = "default";
  private webNotifyPermissionUpdatedAt = 0;

  /** Mark an agent as focused (user is actively viewing it). */
  setFocused(agentId: string): void {
    this.focusedAgents.set(agentId, Date.now());
  }

  /** Clear focus for an agent (user navigated away or tab hidden). */
  clearFocused(agentId: string): void {
    this.focusedAgents.delete(agentId);
  }

  /** Clear all focus entries (e.g. user switched away from all agents). */
  clearAll(): void {
    this.focusedAgents.clear();
  }

  /** Returns true if the agent was focused within the last TTL window. */
  isFocused(agentId: string): boolean {
    const ts = this.focusedAgents.get(agentId);
    if (ts === undefined) return false;
    if (Date.now() - ts > FOCUS_TTL_MS) {
      this.focusedAgents.delete(agentId);
      return false;
    }
    return true;
  }

  /** Update the browser notification permission state reported by the client. */
  setWebNotifyPermission(permission: "default" | "granted" | "denied"): void {
    this.webNotifyPermission = permission;
    this.webNotifyPermissionUpdatedAt = Date.now();
  }

  /**
   * Returns true if the browser has notification permission granted
   * and the permission was reported recently (within the focus TTL).
   */
  hasWebNotifyPermission(): boolean {
    if (this.webNotifyPermission !== "granted") return false;
    // Expire stale permission reports — if the client stopped sending
    // heartbeats, assume permission is no longer available.
    if (Date.now() - this.webNotifyPermissionUpdatedAt > FOCUS_TTL_MS) return false;
    return true;
  }
}
