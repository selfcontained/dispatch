import { Bot } from "lucide-react";

import { seatClasses } from "@/lib/agent-seat";
import { cn } from "@/lib/utils";

/**
 * An agent's avatar: a bot face washed in the agent's own accent, its seat
 * number as a solid chip on the corner. The same mark everywhere the agent
 * appears in a stream. Size "md" is a post's avatar, "sm" a folded row's.
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
  const { face, chip } = seatClasses(seat);
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center border",
        size === "md" ? "h-8 w-8 rounded-md" : "h-5 w-5 rounded",
        face,
        className
      )}
      aria-label={`${name}, agent ${seat}`}
      title={`${name} · agent ${seat}`}
      data-testid="chat-avatar-agent"
      data-seat={seat}
    >
      <Bot className={size === "md" ? "h-[18px] w-[18px]" : "h-3 w-3"} aria-hidden />
      <span
        className={cn(
          "absolute flex items-center justify-center font-mono font-bold tabular-nums text-white ring-2 ring-background",
          size === "md"
            ? "-bottom-1.5 -right-1.5 h-[15px] min-w-[15px] rounded-[5px] px-[3px] text-[10px] leading-none"
            : "-bottom-1 -right-1 h-[11px] min-w-[11px] rounded-[3px] px-0.5 text-[8px] leading-none",
          chip
        )}
        aria-hidden
      >
        {seat}
      </span>
    </span>
  );
}
