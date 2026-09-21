import { AgentSeatBadge } from "@/components/app/agent-seat-badge";
import { seatClasses } from "@/lib/agent-seat";
import type { Mentionable, MentionSpan } from "@/lib/mentions";
import { cn } from "@/lib/utils";

/**
 * The agents a typed `@` can name, listed over the composer: seat, name.
 * Keyboard moves the highlight (the composer owns the keys); a click picks.
 */
export function MentionPicker({
  candidates,
  activeIndex,
  onPick,
  onHover,
}: {
  candidates: readonly Mentionable[];
  activeIndex: number;
  onPick: (agent: Mentionable) => void;
  onHover: (index: number) => void;
}): JSX.Element | null {
  if (candidates.length === 0) return null;
  return (
    <div
      className="absolute bottom-full left-0 z-20 mb-1 w-64 max-w-full overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
      role="listbox"
      aria-label="Mention an agent"
      data-testid="mention-picker"
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
        >
          {agent.seat !== undefined ? (
            <AgentSeatBadge seat={agent.seat} name={agent.name} size="sm" />
          ) : (
            <span className="h-5 w-5 shrink-0 rounded border border-border bg-muted/50" />
          )}
          <span className="min-w-0 flex-1 truncate">{agent.name}</span>
          {agent.seat !== undefined ? (
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              @{agent.seat}
            </span>
          ) : null}
        </button>
      ))}
    </div>
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
            className={cn(
              "rounded px-1 font-medium",
              span.agent.seat !== undefined
                ? seatClasses(span.agent.seat).face
                : "bg-muted text-foreground"
            )}
            data-testid="chat-mention"
            data-agent-id={span.agent.id}
          >
            {span.text}
          </span>
        ) : (
          <span key={index}>{span.text}</span>
        )
      )}
    </>
  );
}
