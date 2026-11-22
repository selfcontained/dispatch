import type { SharedUiEvent } from "@dispatch/shared";
import {
  Bell,
  ClipboardList,
  type LucideIcon,
  MessageCircleQuestion,
  OctagonX,
  ShieldAlert,
  X,
} from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  Link,
  type NavigateFunction,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { toast, Toaster } from "sonner";

import { conversationLocation } from "@/components/app/chat/conversation-location-link";
import { Markdown } from "@/components/ui/markdown";
import { useAgentFocus, viewingAgentIdOf } from "@/hooks/use-agent-focus";
import { formatRelativeTime } from "@/lib/format";
import { agentRoute } from "@/lib/agent-routes";

export type AttentionToastEvent = Extract<
  SharedUiEvent,
  { type: "attention.toast" }
>;

const ATTENTION_TOAST_MS = 10_000;
/** Its own toaster, so it can sit clear of the composer on desktop. */
const TOASTER_ID = "attention";
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
    /** A tint layered over the opaque card, never replacing its background. */
    hover: string;
  }
> = {
  question: {
    label: "Question",
    Icon: MessageCircleQuestion,
    border: "border-status-waiting/line-strong",
    bar: "bg-status-waiting",
    tile: "bg-status-waiting",
    text: "text-status-waiting",
    hover:
      "[@media(hover:hover)]:hover:[background-image:linear-gradient(hsl(var(--status-waiting)/0.12),hsl(var(--status-waiting)/0.12))] active:[background-image:linear-gradient(hsl(var(--status-waiting)/0.2),hsl(var(--status-waiting)/0.2))]",
  },
  form: {
    label: "Form",
    Icon: ClipboardList,
    border: "border-status-done/line-strong",
    bar: "bg-status-done",
    tile: "bg-status-done",
    text: "text-status-done",
    hover:
      "[@media(hover:hover)]:hover:[background-image:linear-gradient(hsl(var(--status-done)/0.12),hsl(var(--status-done)/0.12))] active:[background-image:linear-gradient(hsl(var(--status-done)/0.2),hsl(var(--status-done)/0.2))]",
  },
  approval: {
    label: "Approval",
    Icon: ShieldAlert,
    border: "border-status-merged/line-strong",
    bar: "bg-status-merged",
    tile: "bg-status-merged",
    text: "text-status-merged",
    hover:
      "[@media(hover:hover)]:hover:[background-image:linear-gradient(hsl(var(--status-merged)/0.12),hsl(var(--status-merged)/0.12))] active:[background-image:linear-gradient(hsl(var(--status-merged)/0.2),hsl(var(--status-merged)/0.2))]",
  },
  notice: {
    label: "Notice",
    Icon: Bell,
    border: "border-status-reviewing/line-strong",
    bar: "bg-status-reviewing",
    tile: "bg-status-reviewing",
    text: "text-status-reviewing",
    hover:
      "[@media(hover:hover)]:hover:[background-image:linear-gradient(hsl(var(--status-reviewing)/0.12),hsl(var(--status-reviewing)/0.12))] active:[background-image:linear-gradient(hsl(var(--status-reviewing)/0.2),hsl(var(--status-reviewing)/0.2))]",
  },
  blocked: {
    label: "Blocked",
    Icon: OctagonX,
    border: "border-status-blocked/line-strong",
    bar: "bg-status-blocked",
    tile: "bg-status-blocked",
    text: "text-status-blocked",
    hover:
      "[@media(hover:hover)]:hover:[background-image:linear-gradient(hsl(var(--status-blocked)/0.12),hsl(var(--status-blocked)/0.12))] active:[background-image:linear-gradient(hsl(var(--status-blocked)/0.2),hsl(var(--status-blocked)/0.2))]",
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

/**
 * Whether the item belongs to the agent this tab has open: it's that agent's
 * own, or it sits in that agent's stream (an agent's home stream id is its
 * agent id), such as a child's question shown in its parent's chat.
 */
export function isForOpenAgent(
  event: AttentionToastEvent,
  viewingAgentId: string | null
): boolean {
  if (!viewingAgentId) return false;
  return (
    event.agentId === viewingAgentId ||
    event.target?.streamId === viewingAgentId
  );
}

function showAttentionToast(
  event: AttentionToastEvent,
  navigate: NavigateFunction
): void {
  if (shown.has(event.toastId)) return;
  // A card with nothing to say is an empty box; the drawer still lists it.
  if (!event.message?.trim()) return;
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
      <AttentionCard
        event={event}
        onOpen={open}
        onDismiss={() => toast.dismiss(id)}
      />
    ),
    { id, duration: ATTENTION_TOAST_MS, toasterId: TOASTER_ID }
  );
}

export function AttentionCard({
  event,
  onOpen,
  onDismiss,
  createdAt,
  settled = false,
  link = false,
}: {
  event: AttentionToastEvent;
  onOpen: () => void;
  onDismiss?: () => void;
  createdAt?: string;
  settled?: boolean;
  link?: boolean;
}): JSX.Element {
  const style = KIND_STYLE[event.kind] ?? KIND_STYLE.question;
  const { Icon } = style;
  const ids = useId();
  const messageRef = useRef<HTMLSpanElement>(null);
  // The tooltip shows the whole message as read, not its Markdown source.
  // It sits on the action, which is what the pointer hovers.
  const [title, setTitle] = useState("");
  useLayoutEffect(() => {
    setTitle(
      messageRef.current?.textContent?.replace(/\s+/g, " ").trim() ?? ""
    );
  }, [event.message]);
  // The action covers the card but holds no content, so the message's own
  // links aren't nested inside it. It's named from the rendered text, which
  // reads as plain words with no Markdown symbols.
  const actionProps = {
    className:
      "absolute inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    "aria-labelledby": [
      `${ids}-name`,
      `${ids}-kind`,
      `${ids}-message`,
      settled ? `${ids}-settled` : null,
      createdAt ? `${ids}-time` : null,
    ]
      .filter(Boolean)
      .join(" "),
    title,
  };
  return (
    <div
      className={`flex w-full items-stretch border bg-popover text-popover-foreground shadow-elev-popover transition-colors [font-family:var(--font-terminal)] ${style.border} ${style.hover} ${settled ? "opacity-50" : ""}`}
    >
      <span aria-hidden className={`w-1 shrink-0 ${style.bar}`} />
      <div
        className="relative flex min-w-0 flex-1 items-start gap-3 px-3 py-3 text-left"
        data-testid={createdAt ? "attention-history-card" : "attention-toast"}
        data-kind={event.kind}
      >
        {link ? (
          <Link
            to={attentionToastLocation(event)}
            onClick={(event) => {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              onOpen();
            }}
            state={{ blockJump: `${Date.now()}-${event.toastId}` }}
            {...actionProps}
          />
        ) : (
          <button type="button" onClick={onOpen} {...actionProps} />
        )}
        <span
          aria-hidden
          className={`pointer-events-none flex size-9 shrink-0 items-center justify-center text-background ${style.tile}`}
        >
          <Icon className="size-5" strokeWidth={2.25} />
        </span>
        <span className="pointer-events-none min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-3">
            <span
              id={`${ids}-name`}
              className="truncate text-body-md font-semibold"
            >
              {event.agentName}
            </span>
            <span
              id={`${ids}-kind`}
              className={`shrink-0 section-label ${style.text}`}
            >
              {style.label}
            </span>
          </span>
          <span
            id={`${ids}-message`}
            ref={messageRef}
            className="mt-1 block text-body-sm leading-snug text-muted-foreground"
          >
            <Markdown
              variant="compact"
              className={`[&_a]:pointer-events-auto [&_a]:relative ${createdAt ? "block truncate" : "line-clamp-2"}`}
            >
              {event.message}
            </Markdown>
          </span>
          {settled ? (
            <span id={`${ids}-settled`} className="sr-only">
              Settled
            </span>
          ) : null}
          {createdAt ? (
            <time
              id={`${ids}-time`}
              dateTime={createdAt}
              className="mt-1 block text-label-sm text-muted-foreground"
            >
              {formatRelativeTime(createdAt)}
            </time>
          ) : null}
        </span>
      </div>

      {onDismiss ? (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="shrink-0 self-start p-3 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <X className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Mirrors how far the visible area is scrolled down the page into the
 * `--vv-top` CSS variable. On iPhone an open keyboard scrolls the page up to
 * keep the composer in view; the toast's top offset adds this so it stays at
 * the top of what's visible. Written straight to the style, never React
 * state, so scrolling doesn't re-render anything.
 */
function useVisualViewportTopVar(enabled: boolean): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!enabled || !viewport) return;
    const root = document.documentElement;
    let last = -1;
    const update = () => {
      const top = Math.max(0, Math.round(viewport.offsetTop));
      if (top === last) return;
      last = top;
      root.style.setProperty("--vv-top", `${top}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      root.style.removeProperty("--vv-top");
    };
  }, [enabled]);
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
  const viewingAgentId = viewingAgentIdOf(pathname);
  useAgentFocus(viewingAgentId, "authenticated");
  const navigate = useNavigate();
  useEffect(() => {
    const onToast = (event: Event) => {
      const detail = (event as CustomEvent<AttentionToastEvent>).detail;
      // The server skips focused viewers; this also covers an unfocused
      // window and heartbeat lag. The drawer still lists the item.
      if (isForOpenAgent(detail, viewingAgentId)) return;
      showAttentionToast(detail, navigate);
    };
    bus.addEventListener(EVENT_NAME, onToast);
    return () => bus.removeEventListener(EVENT_NAME, onToast);
  }, [navigate, viewingAgentId]);
  useVisualViewportTopVar(isMobile);
  // Pinned to the top edge on every screen, whatever the screen is: top
  // right on desktop, nearly full width under the status bar on mobile. When the
  // iPhone keyboard scrolls the page, it follows the top of what's visible,
  // so it never covers the composer.
  const mobileTop = "calc(var(--safe-area-top) + var(--vv-top, 0px) + 0.5rem)";
  return (
    <Toaster
      id={TOASTER_ID}
      position={isMobile ? "top-center" : "top-right"}
      className="attention-toaster"
      offset={
        isMobile
          ? { top: mobileTop, left: "0.5rem", right: "0.5rem" }
          : // Below the top inset band (iPad), which #safe-area-top covers.
            {
              top: "calc(var(--safe-area-top) + 0.75rem)",
              right: "0.75rem",
            }
      }
      mobileOffset={{ top: mobileTop, left: "0.5rem", right: "0.5rem" }}
    />
  );
}
