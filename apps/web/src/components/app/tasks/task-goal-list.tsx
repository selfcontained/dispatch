import { Check, Circle, MinusCircle } from "lucide-react";
import type {
  TaskGoal,
  TaskGoalChange,
} from "../../../../../server/src/tasks/types";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { TaskGoalProgress } from "./task-goal-progress";

const STATE: Record<
  TaskGoal["state"],
  { label: string; tone: BadgeTone; icon: typeof Check }
> = {
  open: { label: "Open", tone: "neutral", icon: Circle },
  completed: { label: "Complete", tone: "success", icon: Check },
  retired: { label: "Retired", tone: "neutral", icon: MinusCircle },
};

/** Read-only, ordered goals with an explicit status word on each. */
export function TaskGoalList({ goals }: { goals: TaskGoal[] }) {
  const counts = {
    completed: goals.filter((goal) => goal.state === "completed").length,
    total: goals.filter((goal) => goal.state !== "retired").length,
  };
  return (
    <div className="space-y-3">
      <TaskGoalProgress counts={counts} />
      <ol className="space-y-1.5">
        {goals.map((goal) => {
          const state = STATE[goal.state];
          const Icon = state.icon;
          return (
            <li
              key={goal.id}
              data-testid={`task-goal-${goal.id}`}
              className="flex items-start gap-2 text-body-md"
            >
              <Icon
                aria-hidden="true"
                className={cn(
                  "mt-0.5 size-icon-md shrink-0",
                  goal.state === "completed" ? "text-success" : "text-faint"
                )}
              />
              <span
                className={cn(
                  "min-w-0 flex-1 break-words",
                  goal.state === "retired" &&
                    "text-muted-foreground line-through"
                )}
              >
                {goal.title}
              </span>
              <Badge size="sm" tone={state.tone}>
                {state.label}
              </Badge>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const VERB: Record<TaskGoalChange["op"], string> = {
  added: "Added",
  renamed: "Renamed",
  completed: "Completed",
  reopened: "Reopened",
  retired: "Retired",
};

/** One line per change in a `goals_changed` activity event. */
export function goalChangeLines(data: Record<string, unknown>): string[] {
  const changes = Array.isArray(data.changes)
    ? (data.changes as TaskGoalChange[])
    : [];
  return changes.map((change) =>
    change.op === "renamed"
      ? `Renamed “${change.fromTitle ?? ""}” to “${change.title}”`
      : `${VERB[change.op] ?? change.op} “${change.title}”`
  );
}
