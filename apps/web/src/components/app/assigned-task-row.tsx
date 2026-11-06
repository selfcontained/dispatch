import { ListChecks } from "lucide-react";
import { useLocation, useSearchParams } from "react-router-dom";
import { useAssignedTasks, useTaskBoard } from "@/hooks/use-tasks";
import { Button } from "@/components/ui/button";
import { BLOCK_PARAM, FINDING_PARAM, THREAD_PARAM } from "@/lib/agent-routes";
import { columnAccent, orderedColumns } from "./tasks/task-utils";
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
  return (
    <Button
      variant="ghost"
      className="-mx-1.5 h-auto w-[calc(100%+0.75rem)] min-w-0 justify-start gap-3 rounded-md px-1.5 py-1 text-left text-xs font-normal hover:bg-muted focus-visible:ring-2"
      title={`${current.title} — ${column.name}`}
      aria-label={`Task: ${current.title}, ${column.name}`}
      aria-haspopup="dialog"
      onClick={() => {
        const next = new URLSearchParams(params);
        next.delete(THREAD_PARAM);
        next.delete(FINDING_PARAM);
        if (params.has(THREAD_PARAM)) next.delete(BLOCK_PARAM);
        next.set("task", current.id);
        next.set(TASK_PANE_PARAM, "conversation");
        const alreadyOpen = params.has("task");
        setParams(next, {
          replace: alreadyOpen,
          state: alreadyOpen ? location.state : TASK_MODAL_STATE,
        });
      }}
    >
      <ListChecks
        className="h-3.5 w-3.5 shrink-0 self-start text-muted-foreground/75"
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-foreground">{current.title}</span>
        <span
          className="flex items-center gap-1 text-[10px]"
          style={{
            color: `hsl(${columnAccent(
              column,
              columns.findIndex((item) => item.id === column.id)
            )})`,
          }}
        >
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-current"
            aria-hidden="true"
          />
          <span className="truncate">{column.name}</span>
        </span>
      </span>
    </Button>
  );
}
