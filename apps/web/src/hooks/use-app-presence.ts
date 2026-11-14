import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

import { APP_SESSION_ID } from "@/lib/app-session";

const HEARTBEAT_INTERVAL_MS = 15_000;
const INTERACTION_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
  "touchstart",
] as const;

/** The agent a path shows: `/agents/<id>…` or its history page. */
export function viewingAgentIdOf(pathname: string): string | null {
  const match = /^\/(?:agents|activity\/history)\/([^/]+)/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function postPresence(body: Record<string, unknown>): void {
  void fetch("/api/v1/presence", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: APP_SESSION_ID, ...body }),
    keepalive: true,
  }).catch(() => {});
}

/**
 * Reports this session's presence — visible or not, how long since the last
 * interaction, and which agent it shows — so the server can toast an active
 * session instead of raising an OS notification. Mounted once at the app root.
 */
export function useAppPresence(): void {
  const { pathname } = useLocation();
  const viewingAgentId = viewingAgentIdOf(pathname);
  const lastInteractionRef = useRef(Date.now());
  const sendRef = useRef<() => void>(() => {});

  useEffect(() => {
    const send = () =>
      postPresence({
        visible: !document.hidden,
        idleMs: Date.now() - lastInteractionRef.current,
        viewingAgentId,
      });
    sendRef.current = send;
    send();
    const interval = setInterval(send, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [viewingAgentId]);

  useEffect(() => {
    const onInteraction = () => {
      const wasIdle =
        Date.now() - lastInteractionRef.current > HEARTBEAT_INTERVAL_MS;
      lastInteractionRef.current = Date.now();
      // Back from idle: say so now rather than at the next beat.
      if (wasIdle) sendRef.current();
    };
    const onVisibility = () => {
      if (!document.hidden) lastInteractionRef.current = Date.now();
      sendRef.current();
    };
    const onPageHide = () => postPresence({ closed: true });
    for (const type of INTERACTION_EVENTS)
      window.addEventListener(type, onInteraction, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      for (const type of INTERACTION_EVENTS)
        window.removeEventListener(type, onInteraction);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);
}
