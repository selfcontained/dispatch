import { ListChecks } from "lucide-react";
import { useLocation, useSearchParams } from "react-router-dom";
import { useAssignedTasks, useTaskBoard } from "@/hooks/use-tasks";
import { BLOCK_PARAM, FINDING_PARAM, THREAD_PARAM } from "@/lib/agent-routes";
import { RowButton } from "@/components/ui/row-button";
import { StatusDot } from "@/components/ui/status-dot";
import { Hint } from "@/components/ui/tooltip";
import { columnAccent, orderedColumns } from "./tasks/task-utils";
import { TaskGoalProgress, goalProgressText } from "./tasks/task-goal-progress";
import { TASK_MODAL_STATE, TASK_PANE_PARAM } from "./tasks/task-utils";

/** Preserve the header's first-association choice: API position/createdAt/id order. */
export function AssignedTaskRow({ agentId }: { agentId: string }) {
  const assigned = useAssignedTasks(agentId);
  const task = assigned.data?.[0];
  const board = useTaskBoard(task?.projectId ?? null);
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  // Resolve against the current authorized board as well as the assignment list.
  // Refetch errors must not leave a cached task identity/status visible.
  const current = board.data?.tasks.find(
    (candidate) =>
      candidate.id === task?.id &&
      candidate.assignedAgentId === agentId &&
      !candidate.archivedAt
  );
  const column = board.data?.columns.find(
    (candidate) => candidate.id === current?.columnId
  );
  if (assigned.isError || board.isError || !current || !column) return null;
  const columns = orderedColumns(board.data!);
  const goals = current.goalCounts?.total ? current.goalCounts : null;
  const summary = `${current.title} — ${column.name}${goals ? ` · ${goalProgressText(goals)}` : ""}`;
  return (
    <Hint label={summary}>
      <RowButton
        className="-mx-1.5 min-h-7 w-[calc(100%+0.75rem)] min-w-0 gap-3 px-1.5 text-body-sm text-muted-foreground"
        aria-label={`Task: ${current.title}, ${column.name}${goals ? `, ${goalProgressText(goals)}` : ""}`}
        aria-haspopup="dialog"
        onClick={() => {
          const next = new URLSearchParams(params);
          next.delete(THREAD_PARAM);
          next.delete(FINDING_PARAM);
          if (params.has(THREAD_PARAM)) next.delete(BLOCK_PARAM);
          next.set("task", current.id);
          next.set(TASK_PANE_PARAM, "details");
          const alreadyOpen = params.has("task");
          setParams(next, {
            replace: alreadyOpen,
            state: alreadyOpen ? location.state : TASK_MODAL_STATE,
          });
        }}
      >
        <ListChecks
          className="size-icon-md shrink-0 self-start text-faint"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-foreground">
            {current.title}
          </span>
          <TaskGoalProgress counts={current.goalCounts} className="my-1" />
          <span
            className="flex items-center gap-1 text-label-xs"
            style={{
              color: `hsl(${columnAccent(
                column,
                columns.findIndex((item) => item.id === column.id)
              )})`,
            }}
          >
            <StatusDot size="sm" tone="current" />
            <span className="truncate">{column.name}</span>
          </span>
        </span>
      </RowButton>
    </Hint>
  );
}
