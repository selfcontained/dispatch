import "../chat/turn/activity-glow.css";
import { useState, type CSSProperties } from "react";
import type { TaskGoalCounts } from "../../../../../server/src/tasks/types";
import { cn } from "@/lib/utils";

export function goalProgressText({ completed, total }: TaskGoalCounts) {
  return `${completed} of ${total} goal${total === 1 ? "" : "s"} complete`;
}

/** The turn-activity "checks" colour, as its defrag cells draw it. */
const DONE = "hsl(var(--status-working))";
const tint = (alpha: number) =>
  `color-mix(in srgb, ${DONE} ${alpha}%, transparent)`;

/** A quieter take on the defrag cells' `halo-soft` glow, sized for a 6px bar. */
const GLOW = {
  "--neon-color": DONE,
  "--neon-edge": "20%",
  "--neon-near": "3px",
  "--neon-far": "8px",
  "--neon-strength": "35%",
} as CSSProperties;

/**
 * Equal-segment progress over a task's current goals, with the count as
 * text so it never depends on colour. Renders nothing without goals.
 * Completed segments borrow the turn-activity defrag cells' look: the
 * newest lit at full strength, earlier ones at 75%, a glow, and a brief
 * pulse when one completes while watched.
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
  const { arrivals, sweeps } = useGoalTransitions(counts);
  const [sweepDone, setSweepDone] = useState(0);
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
        data-glow="goal"
        style={GLOW}
        // One track split by hairline gaps with only its outer ends rounded:
        // segments of a single bar, not separate pills.
        className={cn(
          "relative flex h-1.5 min-w-0 flex-1",
          total > 16 ? "gap-px" : "gap-0.5"
        )}
      >
        {Array.from({ length: total }, (_, index) => {
          const done = index < completed;
          const newest = index === completed - 1;
          return (
            <span
              // Remounting the newest cell on each arrival replays its pulse.
              key={newest ? `newest-${arrivals}` : index}
              data-neon-swatch={done ? "" : undefined}
              data-goal-segment={done ? "done" : "open"}
              className={cn(
                "min-w-px flex-1 transition-[background-color] duration-500 motion-reduce:transition-none",
                index === 0 && "rounded-l-full",
                index === total - 1 && "rounded-r-full",
                newest && arrivals > 0 && "dispatch-defrag-ack"
              )}
              style={{
                background: done ? tint(newest ? 100 : 75) : tint(12),
              }}
            />
          );
        })}
        {sweeps > sweepDone && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 overflow-hidden rounded-full"
          >
            <span
              key={sweeps}
              data-testid="goal-complete-sweep"
              className="goal-complete-sweep"
              onAnimationEnd={(event) => {
                // Both iterations end in one animationend, after the last.
                if (event.target === event.currentTarget) setSweepDone(sweeps);
              }}
            />
          </span>
        )}
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

/**
 * Counts, while this bar is mounted in a visible page, how often a goal
 * completed (`arrivals`) and how often the bar went from incomplete to fully
 * complete (`sweeps`). The first render never counts, so a bar that loads
 * complete stays still.
 */
function useGoalTransitions(counts: TaskGoalCounts | undefined) {
  const key = counts ? `${counts.completed}/${counts.total}` : "";
  const [seen, setSeen] = useState(key);
  const [arrivals, setArrivals] = useState(0);
  const [sweeps, setSweeps] = useState(0);
  if (key !== seen) {
    // Adjusting state during render: React re-renders before committing.
    const [before = 0, of = 0] = seen ? seen.split("/").map(Number) : [];
    setSeen(key);
    const visible =
      typeof document === "undefined" || document.visibilityState === "visible";
    if (visible && counts) {
      if (counts.completed > before) setArrivals((count) => count + 1);
      if (before < of && counts.total > 0 && counts.completed === counts.total)
        setSweeps((count) => count + 1);
    }
  }
  return { arrivals, sweeps };
}
