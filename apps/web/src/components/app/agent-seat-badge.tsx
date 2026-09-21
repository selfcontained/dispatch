import { seatClasses } from "@/lib/agent-seat";
import { cn } from "@/lib/utils";

/**
 * An agent's seat as its avatar: its number in its own accent, the same
 * everywhere it appears in a stream. Size "md" is a post's avatar, "sm"
 * a folded row's mark.
 */
export function AgentSeatBadge({
  seat,
  name,
  size = "md",
  className,
}: {
  seat: number;
  name: string;
  size?: "md" | "sm";
  className?: string;
}): JSX.Element {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md border font-mono font-semibold tabular-nums",
        size === "md" ? "h-8 w-8 text-sm" : "h-5 w-5 rounded text-[10px]",
        seatClasses(seat),
        className
      )}
      aria-label={`${name}, agent ${seat}`}
      title={`${name} · agent ${seat}`}
      data-testid="chat-avatar-agent"
      data-seat={seat}
    >
      {seat}
    </span>
  );
}
