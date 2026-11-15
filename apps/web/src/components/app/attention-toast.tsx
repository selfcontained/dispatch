import type { SharedUiEvent } from "@dispatch/shared";
import {
  ClipboardList,
  type LucideIcon,
  MessageCircleQuestion,
  OctagonX,
  ShieldAlert,
  X,
} from "lucide-react";
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

type ToastKind = AttentionToastEvent["kind"];

/** Each kind's label, icon and status color (literal classes for Tailwind). */
const KIND_STYLE: Record<
  ToastKind,
  {
    label: string;
    Icon: LucideIcon;
    border: string;
    bar: string;
    tile: string;
    text: string;
    hover: string;
  }
> = {
  question: {
    label: "Question",
    Icon: MessageCircleQuestion,
    border: "border-status-waiting/60",
    bar: "bg-status-waiting",
    tile: "bg-status-waiting",
    text: "text-status-waiting",
    hover: "hover:bg-status-waiting/10",
  },
  form: {
    label: "Form",
    Icon: ClipboardList,
    border: "border-status-done/60",
    bar: "bg-status-done",
    tile: "bg-status-done",
    text: "text-status-done",
    hover: "hover:bg-status-done/10",
  },
  approval: {
    label: "Approval",
    Icon: ShieldAlert,
    border: "border-status-merged/60",
    bar: "bg-status-merged",
    tile: "bg-status-merged",
    text: "text-status-merged",
    hover: "hover:bg-status-merged/10",
  },
  blocked: {
    label: "Blocked",
    Icon: OctagonX,
    border: "border-status-blocked/60",
    bar: "bg-status-blocked",
    tile: "bg-status-blocked",
    text: "text-status-blocked",
    hover: "hover:bg-status-blocked/10",
  },
};
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
  const style = KIND_STYLE[event.kind] ?? KIND_STYLE.question;
  const { Icon } = style;
  toast.custom(
    () => (
      <div
        className={`flex w-full items-stretch border bg-popover text-popover-foreground shadow-[0_16px_40px_-12px_rgb(0_0_0/0.7)] transition-colors [font-family:var(--font-terminal)] ${style.border} ${style.hover}`}
      >
        <span aria-hidden className={`w-1 shrink-0 ${style.bar}`} />
        <button
          type="button"
          onClick={open}
          className="flex min-w-0 flex-1 items-start gap-3 px-3 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          data-testid="attention-toast"
          data-kind={event.kind}
        >
          <span
            aria-hidden
            className={`flex size-9 shrink-0 items-center justify-center text-background ${style.tile}`}
          >
            <Icon className="size-5" strokeWidth={2.25} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-3">
              <span className="truncate text-sm font-semibold">
                {event.agentName}
              </span>
              <span
                className={`shrink-0 text-[11px] font-semibold uppercase tracking-[0.14em] ${style.text}`}
              >
                {style.label}
              </span>
            </span>
            <span className="mt-1 line-clamp-2 text-[13px] leading-snug text-muted-foreground">
              {event.message}
            </span>
          </span>
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => toast.dismiss(id)}
          className="shrink-0 self-start p-3 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
  // composer. Mobile: edge to edge, above the composer and nav.
  return (
    <Toaster
      id={TOASTER_ID}
      position={isMobile ? "bottom-center" : "top-right"}
      className="attention-toaster"
      offset={
        isMobile
          ? // Sonner applies --mobile-offset-bottom only up to 600px; the
            // mobile layout runs to 767px, so lift it above the nav here too.
            { bottom: MOBILE_BOTTOM_OFFSET, left: "0px", right: "0px" }
          : { top: "7rem", right: "1rem" }
      }
      mobileOffset={{ bottom: MOBILE_BOTTOM_OFFSET, left: "0px", right: "0px" }}
    />
  );
}
