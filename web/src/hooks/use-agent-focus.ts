import { useEffect, useRef } from "react";
import type { AuthState } from "@/components/app/types";

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Sends periodic focus heartbeats to the server so it knows the user is
 * actively viewing a specific agent. The server uses this to suppress
 * redundant Slack notifications.
 *
 * Heartbeats are only sent when:
 * - The user is authenticated
 * - The browser tab is visible and focused
 * - An agent is selected
 *
 * When any condition becomes false, a null-focus signal is sent so the
 * server can let the TTL expire naturally.
 */
export function useAgentFocus(
  selectedAgentId: string | null,
  authState: AuthState,
): void {
  const lastReportedRef = useRef<string | null>(null);

  useEffect(() => {
    if (authState !== "authenticated") return;

    const sendFocus = (agentId: string | null) => {
      lastReportedRef.current = agentId;
      void fetch("/api/v1/focus", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId }),
        keepalive: true,
      }).catch(() => {});
    };

    const isPageActive = () => document.hasFocus() && !document.hidden;

    const tick = () => {
      if (isPageActive() && selectedAgentId) {
        sendFocus(selectedAgentId);
      }
    };

    // Send immediately if conditions are met
    tick();

    const interval = setInterval(tick, HEARTBEAT_INTERVAL_MS);

    const onVisibilityChange = () => {
      if (!isPageActive() && lastReportedRef.current) {
        sendFocus(null);
      } else if (isPageActive() && selectedAgentId) {
        sendFocus(selectedAgentId);
      }
    };

    const onBlur = () => {
      if (lastReportedRef.current) {
        sendFocus(null);
      }
    };

    const onFocus = () => {
      if (selectedAgentId && !document.hidden) {
        sendFocus(selectedAgentId);
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      if (lastReportedRef.current) {
        sendFocus(null);
      }
    };
  }, [authState, selectedAgentId]);
}
