import { ListChecks } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useAssignedTasks, useTaskBoard } from "@/hooks/use-tasks";
import { Button } from "@/components/ui/button";
import { TASK_MODAL_STATE, TASK_PANE_PARAM } from "./tasks/task-utils";

/** Preserve the header's first-association choice: API position/createdAt/id order. */
export function AssignedTaskRow({ agentId }: { agentId: string }) {
  const assigned = useAssignedTasks(agentId);
  const task = assigned.data?.[0];
  const board = useTaskBoard(task?.projectId ?? null);
  const [params, setParams] = useSearchParams();
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
  return (
    <Button
      variant="ghost"
      className="h-auto w-full min-w-0 justify-start gap-3 rounded-sm p-0 text-left text-xs font-normal hover:bg-muted focus-visible:ring-2"
      title={`${current.title} — ${column.name}`}
      aria-label={`Task: ${current.title}, ${column.name}`}
      aria-haspopup="dialog"
      onClick={() => {
        const next = new URLSearchParams(params);
        next.set("task", current.id);
        next.set(TASK_PANE_PARAM, "conversation");
        setParams(next, { state: TASK_MODAL_STATE });
      }}
    >
      <ListChecks
        className="h-3.5 w-3.5 shrink-0 self-start text-muted-foreground/75"
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-foreground">{current.title}</span>
        <span className="block truncate text-[10px] text-muted-foreground">
          {column.name}
        </span>
      </span>
    </Button>
  );
}
