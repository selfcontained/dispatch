import { useEffect } from "react";
import type { AuthState } from "@/components/app/types";
import { APP_SESSION_ID } from "@/lib/app-session";

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * The agent an `/agents/<id>…` path shows. Not checked against the agent
 * list: an unknown id only marks focus on an agent that never notifies.
 */
export function viewingAgentIdOf(pathname: string): string | null {
  const match = /^\/agents\/([^/]+)/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * One 15 s heartbeat per tab that carries both signals the server needs:
 *
 * - focus: `agentId` is the agent the user is actively viewing (tab visible
 *   and focused), or null. Suppresses redundant notices for that agent.
 * - presence: this tab's session id, whether it is visible and focused, the
 *   agent it shows, and `active` when the beat comes from the user acting
 *   (opening a route, focusing the window, showing the tab).
 *
 * Beats run while the tab is visible; a hidden tab sends one beat saying so
 * and then stays quiet. Only window focus/blur and visibility changes are
 * observed — never input events.
 */
export function useAgentFocus(
  viewingAgentId: string | null,
  authState: AuthState
): void {
  useEffect(() => {
    if (authState !== "authenticated") return;

    const send = (active: boolean) => {
      const visible = document.visibilityState === "visible";
      const focused = visible && document.hasFocus();
      void fetch("/api/v1/focus", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: focused ? viewingAgentId : null,
          sessionId: APP_SESSION_ID,
          visible,
          focused,
          active: active && visible,
          viewingAgentId,
        }),
        keepalive: true,
      }).catch(() => {});
    };

    // Mounting means the page opened or the route changed: the user acted.
    send(true);

    const interval = setInterval(() => {
      if (document.visibilityState === "visible") send(false);
    }, HEARTBEAT_INTERVAL_MS);

    const onVisibilityChange = () =>
      send(document.visibilityState === "visible");
    const onFocus = () => send(true);
    const onBlur = () => send(false);

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, [authState, viewingAgentId]);
}
