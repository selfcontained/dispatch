/**
 * In-memory tracker for which agents the user is actively viewing in the UI.
 * Used to suppress redundant Slack notifications when the user is already
 * looking at the agent. State is ephemeral — server restart clears all focus,
 * which is the safe default (notifications resume).
 */

const FOCUS_TTL_MS = 30_000;

export class FocusTracker {
  private focusedAgents = new Map<string, number>();

  /** Mark an agent as focused (user is actively viewing it). */
  setFocused(agentId: string): void {
    this.focusedAgents.set(agentId, Date.now());
  }

  /** Clear focus for an agent (user navigated away or tab hidden). */
  clearFocused(agentId: string): void {
    this.focusedAgents.delete(agentId);
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
}
