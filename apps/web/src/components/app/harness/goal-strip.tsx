import { useState } from "react";
import { Crosshair } from "lucide-react";

import { cn } from "@/lib/utils";

import type { GoalState } from "./registry";

/**
 * The agent's standing goal, as dsh's goal tools last reported it: the
 * loop that keeps running rounds on its own ("monitoring is armed") after
 * a turn has settled. Without this, an armed goal looks like nothing is
 * happening. Shown while the goal is active or blocked.
 */
export function GoalStrip({ goal }: { goal: GoalState }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (goal.phase !== "active" && goal.phase !== "blocked") return null;
  const blocked = goal.phase === "blocked";
  const rounds =
    goal.maxRounds > 0
      ? `round ${goal.roundsStarted} of ${goal.maxRounds}`
      : `round ${goal.roundsStarted}`;
  return (
    <div
      className={cn(
        "mb-1.5 rounded-md border px-2.5 py-1.5",
        blocked
          ? "border-status-blocked/40 bg-status-blocked/5"
          : "border-status-working/40 bg-status-working/5"
      )}
      data-testid="harness-goal"
      data-phase={goal.phase}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-status-working/50 pointer-coarse:min-h-11"
        data-testid="harness-goal-toggle"
      >
        <Crosshair
          className={cn(
            "h-3 w-3 shrink-0",
            blocked ? "text-status-blocked" : "text-status-working"
          )}
          aria-hidden="true"
        />
        <span className="text-[11px] font-medium text-foreground">Goal</span>
        <span
          className={cn(
            "text-[10.5px]",
            blocked ? "text-status-blocked" : "text-status-working"
          )}
        >
          {blocked ? "blocked" : "armed"}
        </span>
        <span className="text-[10.5px] tabular-nums text-muted-foreground">
          {rounds}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/80">
          · {goal.objective}
        </span>
        <span
          aria-hidden="true"
          className="text-[9px] text-muted-foreground/70"
        >
          {open ? "⏷" : "⏵"}
        </span>
      </button>
      {open ? (
        <div className="mt-1.5 space-y-1 pl-5 text-[11px]">
          <p className="whitespace-pre-wrap text-foreground/85">
            {goal.objective}
          </p>
          {goal.blockedReason ? (
            <p className="whitespace-pre-wrap text-status-blocked">
              Blocked: {goal.blockedReason}
            </p>
          ) : (
            <p className="text-muted-foreground">
              dsh runs another round on its own until the goal completes, is
              blocked, or the rounds run out. Each round shows as its own turn
              above.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
