import { useLocation, useSearchParams } from "react-router-dom";
import { CheckCircle2, ListTodo } from "lucide-react";
import { useTaskBoard, useTaskDetail } from "@/hooks/use-tasks";
import { useProjects } from "@/hooks/use-projects";
import { Badge } from "@/components/ui/badge";
import { TASK_MODAL_STATE, TASK_PANE_PARAM } from "../tasks/task-utils";
import type { Block } from "@dispatch/shared";

export function TaskBlockBody({
  block,
  agentName = (id: string) => id,
}: {
  block: Extract<Block, { kind: "task" }>;
  agentName?: (id: string) => string;
}) {
  const { data: task, isPending, error } = useTaskDetail(block.data.taskId);
  const { data: board } = useTaskBoard(
    error ? null : (task?.projectId ?? null)
  );
  const { data: projects = [] } = useProjects();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  if (error)
    return (
      <div className="my-2 rounded-lg border p-3 text-sm text-muted-foreground">
        Task unavailable
        <span className="mt-1 block font-mono text-xs">
          {block.data.taskId}
        </span>
      </div>
    );
  if (isPending || !task)
    return (
      <div
        role="status"
        aria-label="Loading task"
        className="my-2 h-24 animate-pulse rounded-lg border bg-muted/40"
      />
    );
  const column = board?.columns.find((column) => column.id === task.columnId);
  const done = Boolean(task.completedAt || column?.isDone);
  const Icon = done ? CheckCircle2 : ListTodo;
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      data-testid="stream-task-card"
      className="my-2 flex w-full min-w-0 items-start gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => {
        const next = new URLSearchParams(params);
        const paging = next.has("task");
        next.set("task", task.id);
        next.delete(TASK_PANE_PARAM);
        setParams(next, {
          replace: paging,
          state: paging
            ? location.state
            : { ...location.state, ...TASK_MODAL_STATE },
        });
      }}
    >
      <Icon
        aria-hidden="true"
        className="mt-0.5 h-4 w-4 shrink-0 text-primary"
      />
      <span className="min-w-0 flex-1">
        <span className="block break-words text-sm font-medium">
          {task.title}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>
            {[
              projects.find((project) => project.id === task.projectId)?.name ??
                task.projectId,
              column?.name,
              task.assignedAgentId
                ? agentName(task.assignedAgentId)
                : "Unassigned",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {done && <Badge variant="default">Done</Badge>}
          {task.archivedAt && <Badge variant="stopped">Archived</Badge>}
        </span>
      </span>
    </button>
  );
}
