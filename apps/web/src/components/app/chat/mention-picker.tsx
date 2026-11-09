import { Bell, BellOff } from "lucide-react";
import { AgentSessionLink } from "@/components/app/agent-session-link";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import {
  mentionChipClasses,
  type Mentionable,
  type MentionSpan,
} from "@/lib/mentions";
import { cn } from "@/lib/utils";

/**
 * The agents a typed `@` can name, listed over the composer: seat, name.
 * Keyboard moves the highlight (the composer owns the keys); a click picks.
 */
export function MentionPicker({
  silent = false,
  onSilentChange,
  candidates,
  activeIndex,
  onPick,
  onHover,
  anchor,
}: {
  silent?: boolean;
  onSilentChange: (silent: boolean) => void;
  candidates: readonly Mentionable[];
  activeIndex: number;
  onPick: (agent: Mentionable) => void;
  onHover: (index: number) => void;
  /** The field the list sits over; the composer's box clips, so the list is portalled. */
  anchor: HTMLElement | null;
}): JSX.Element | null {
  if (candidates.length === 0) return null;
  const rect = anchor?.getBoundingClientRect();
  const style = rect
    ? {
        left: Math.max(8, rect.left),
        bottom: Math.max(8, window.innerHeight - rect.top + 4),
      }
    : { left: 8, bottom: 8 };
  return createPortal(
    <div
      className="fixed z-50 w-64 max-w-[calc(100vw-16px)] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
      style={style}
      data-testid="mention-picker"
    >
      <div className="flex justify-end gap-1 border-b border-border px-2 py-1">
        {[false, true].map((mode) => (
          <Button
            variant="ghost"
            size="icon"
            key={String(mode)}
            type="button"
            title={
              mode
                ? "Reference only — won’t notify"
                : "Mention — notifies agent"
            }
            aria-label={
              mode
                ? "Reference only — won’t notify"
                : "Mention — notifies agent"
            }
            aria-pressed={silent === mode}
            className={cn(
              "size-6 rounded p-1",
              silent === mode
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/60"
            )}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSilentChange(mode)}
          >
            {mode ? (
              <BellOff className="size-3.5" />
            ) : (
              <Bell className="size-3.5" />
            )}
          </Button>
        ))}
      </div>
      <div
        role="listbox"
        aria-label={
          silent ? "Reference an agent without notifying" : "Mention an agent"
        }
      >
        {candidates.map((agent, index) => (
          <button
            key={agent.id}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            className={cn(
              "flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm",
              index === activeIndex ? "bg-muted" : "hover:bg-muted/60"
            )}
            // Mouse down would take focus from the textarea and close the
            // list before the click lands.
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onHover(index)}
            onClick={() => onPick(agent)}
            data-testid="mention-option"
            data-agent-id={agent.id}
            title={
              silent
                ? "Reference only — won’t notify"
                : (agent.mentionName ?? agent.name)
            }
            aria-label={
              silent
                ? `${agent.name}, reference only, won’t notify`
                : agent.name
            }
          >
            <span className="min-w-0 flex-1 truncate">
              <span
                className={mentionChipClasses(agent.seat, silent)}
                data-silent={String(silent)}
              >
                {silent ? "!" : ""}@{agent.name}
              </span>
            </span>
            {agent.mentionName ? (
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {agent.id.slice(-6)}
              </span>
            ) : null}
            {agent.seat !== undefined ? (
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                @{agent.seat}
              </span>
            ) : (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                Session
              </span>
            )}
          </button>
        ))}
      </div>
    </div>,
    document.body
  );
}

/** A message with its `@name`s painted in the named agent's colour. */
export function MentionText({
  spans,
}: {
  spans: readonly MentionSpan[];
}): JSX.Element {
  return (
    <>
      {spans.map((span, index) =>
        span.kind === "mention" ? (
          <span
            key={index}
            className={mentionChipClasses(span.agent.seat, span.silent)}
            data-silent={String(!!span.silent)}
            data-testid="chat-mention"
            data-agent-id={span.agent.id}
            title={
              span.silent ? "Reference only — won’t notify" : span.agent.name
            }
            aria-label={
              span.silent
                ? `${span.agent.name}, reference only, won’t notify`
                : span.agent.name
            }
          >
            {span.silent ? (
              <AgentSessionLink
                agentId={span.agent.id}
                name={span.agent.name}
                decorative={false}
                className="!text-inherit !no-underline hover:!underline"
              >
                {span.text}
              </AgentSessionLink>
            ) : (
              span.text
            )}
          </span>
        ) : (
          <span key={index}>{span.text}</span>
        )
      )}
    </>
  );
}
