import type { SharedUiEvent } from "@dispatch/shared";
import { X } from "lucide-react";
import { useEffect } from "react";
import {
  type NavigateFunction,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { toast, Toaster } from "sonner";

import { conversationLocation } from "@/components/app/chat/conversation-location-link";
import { useAgentFocus, viewingAgentIdOf } from "@/hooks/use-agent-focus";
import { agentRoute } from "@/lib/agent-routes";

export type AttentionToastEvent = Extract<
  SharedUiEvent,
  { type: "attention.toast" }
>;

const ATTENTION_TOAST_MS = 10_000;
/** Its own toaster, so it can sit clear of the composer on desktop. */
const TOASTER_ID = "attention";
/** Same lift as `--mobile-offset-bottom` in index.css: clear of the nav and home indicator. */
const MOBILE_BOTTOM_OFFSET = "calc(env(safe-area-inset-bottom, 0px) + 5rem)";
const EVENT_NAME = "attention-toast";
const bus = new EventTarget();
/** Toasts this page already showed: one per item, even if the event repeats. */
const shown = new Set<string>();

/** Hand a toast event from the event stream to the mounted toaster. */
export function announceAttentionToast(event: AttentionToastEvent): void {
  bus.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: event }));
}

/** Where clicking the toast goes: the question or form, else the agent. */
export function attentionToastLocation(event: AttentionToastEvent): {
  pathname: string;
  search: string;
} {
  if (!event.target) return { pathname: agentRoute(event.agentId), search: "" };
  return conversationLocation(event.target, false);
}

function showAttentionToast(
  event: AttentionToastEvent,
  navigate: NavigateFunction
): void {
  if (shown.has(event.toastId)) return;
  shown.add(event.toastId);
  const id = `attention-${event.toastId}`;
  const open = () => {
    toast.dismiss(id);
    navigate(attentionToastLocation(event), {
      state: { blockJump: `${Date.now()}-${event.toastId}` },
    });
  };
  toast.custom(
    () => (
      <div className="relative flex w-[var(--width,356px)] max-w-full items-start rounded-md border bg-card text-card-foreground shadow-lg [font-family:var(--font-terminal)]">
        <button
          type="button"
          onClick={open}
          className="min-w-0 flex-1 rounded-md px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="attention-toast"
        >
          <span className="block truncate text-sm font-medium">
            {event.agentName}
          </span>
          <span className="block truncate text-sm text-muted-foreground">
            {event.message}
          </span>
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => toast.dismiss(id)}
          className="m-2 shrink-0 rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" />
        </button>
      </div>
    ),
    { id, duration: ATTENTION_TOAST_MS, toasterId: TOASTER_ID }
  );
}

/**
 * Runs this tab's focus/presence heartbeat and shows the in-app toasts the
 * server sends it while it's active, in a toaster of their own. Mounted once
 * at the app root.
 */
export function AttentionToasts({
  isMobile,
}: {
  isMobile: boolean;
}): JSX.Element {
  const { pathname } = useLocation();
  useAgentFocus(viewingAgentIdOf(pathname), "authenticated");
  const navigate = useNavigate();
  useEffect(() => {
    const onToast = (event: Event) =>
      showAttentionToast(
        (event as CustomEvent<AttentionToastEvent>).detail,
        navigate
      );
    bus.addEventListener(EVENT_NAME, onToast);
    return () => bus.removeEventListener(EVENT_NAME, onToast);
  }, [navigate]);
  // Desktop: top right, below the conversation header, clear of the
  // composer. Mobile: the shared bottom placement above the nav.
  return (
    <Toaster
      id={TOASTER_ID}
      position={isMobile ? "bottom-right" : "top-right"}
      offset={
        isMobile
          ? // Sonner applies --mobile-offset-bottom only up to 600px; the
            // mobile layout runs to 767px, so lift it above the nav here too.
            { bottom: MOBILE_BOTTOM_OFFSET, right: "1rem" }
          : { top: "7rem", right: "1rem" }
      }
    />
  );
}
