import type { TaskGoalCounts } from "../../../../../server/src/tasks/types";
import { cn } from "@/lib/utils";

export function goalProgressText({ completed, total }: TaskGoalCounts) {
  return `${completed} of ${total} goal${total === 1 ? "" : "s"} complete`;
}

/**
 * Equal-segment progress over a task's current goals, with the count as
 * text so it never depends on colour. Renders nothing without goals.
 */
export function TaskGoalProgress({
  counts,
  compact = false,
  className,
}: {
  counts: TaskGoalCounts | undefined;
  /** "2/3" instead of the sentence, for narrow rows; the bar keeps the sentence. */
  compact?: boolean;
  className?: string;
}) {
  if (!counts || counts.total === 0) return null;
  const { completed, total } = counts;
  const text = goalProgressText(counts);
  return (
    <div
      className={cn("flex min-w-0 items-center gap-2", className)}
      data-testid="task-goal-progress"
    >
      <div
        role="progressbar"
        aria-label="Goals"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={completed}
        aria-valuetext={text}
        // One rounded track split by hairline gaps: square inner edges read
        // as segments of a single bar, not separate pills.
        className={cn(
          "flex h-1.5 min-w-0 flex-1 overflow-hidden rounded-full",
          total > 16 ? "gap-px" : "gap-0.5"
        )}
      >
        {Array.from({ length: total }, (_, index) => (
          <span
            key={index}
            className={cn(
              "min-w-px flex-1",
              index < completed ? "bg-success" : "bg-foreground/tint"
            )}
          />
        ))}
      </div>
      <span
        aria-hidden="true"
        className="shrink-0 text-label-xs tabular-nums text-muted-foreground"
      >
        {compact ? `${completed}/${total}` : text}
      </span>
    </div>
  );
}
