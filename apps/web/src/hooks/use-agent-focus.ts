import { useEffect, useRef } from "react";
import type { AuthState } from "@/components/app/types";
import { APP_SESSION_ID } from "@/lib/app-session";

const HEARTBEAT_INTERVAL_MS = 15_000;
/** Interaction listeners only refresh a local timestamp, at most this often. */
const INTERACTION_THROTTLE_MS = 1_000;
/** Matches the server's active window: idle longer than this is not present. */
const IDLE_THRESHOLD_MS = 120_000;
const INTERACTION_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
  "touchstart",
] as const;

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
 * - presence: this tab's session id, visibility, idle time and the agent it
 *   shows. Lets the server toast an active tab instead of raising an OS
 *   notification.
 *
 * Beats run while the tab is visible; a hidden tab sends one beat saying so
 * and then stays quiet. Focus/blur/visibility changes send immediately, as
 * before. Interaction is tracked locally; the only send it triggers is one
 * beat on the first interaction after more than two minutes idle.
 */
export function useAgentFocus(
  viewingAgentId: string | null,
  authState: AuthState
): void {
  const lastInteractionRef = useRef(Date.now());
  const sendRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const onInteraction = () => {
      const now = Date.now();
      const idleFor = now - lastInteractionRef.current;
      if (idleFor <= INTERACTION_THROTTLE_MS) return;
      lastInteractionRef.current = now;
      // Back from idle: one beat now, so presence doesn't wait for the next tick.
      if (idleFor > IDLE_THRESHOLD_MS) sendRef.current?.();
    };
    for (const type of INTERACTION_EVENTS)
      window.addEventListener(type, onInteraction, { passive: true });
    return () => {
      for (const type of INTERACTION_EVENTS)
        window.removeEventListener(type, onInteraction);
    };
  }, []);

  useEffect(() => {
    if (authState !== "authenticated") return;

    const send = () => {
      const visible = !document.hidden;
      const active = visible && document.hasFocus();
      void fetch("/api/v1/focus", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: active ? viewingAgentId : null,
          sessionId: APP_SESSION_ID,
          visible,
          idleMs: Date.now() - lastInteractionRef.current,
          viewingAgentId,
        }),
        keepalive: true,
      }).catch(() => {});
    };

    sendRef.current = send;
    send();

    const interval = setInterval(() => {
      if (!document.hidden) send();
    }, HEARTBEAT_INTERVAL_MS);

    const onVisibilityChange = () => {
      if (!document.hidden) lastInteractionRef.current = Date.now();
      send();
    };
    const onFocusChange = () => send();

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("blur", onFocusChange);
    window.addEventListener("focus", onFocusChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("blur", onFocusChange);
      window.removeEventListener("focus", onFocusChange);
      sendRef.current = null;
    };
  }, [authState, viewingAgentId]);
}
