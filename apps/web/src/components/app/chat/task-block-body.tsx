import { useLocation, useSearchParams } from "react-router-dom";
import { CheckCircle2, ListTodo } from "lucide-react";
import { useTaskBoard, useTaskDetail } from "@/hooks/use-tasks";
import { useProjects } from "@/hooks/use-projects";
import { useAgentRecord } from "@/hooks/use-agent-tree";
import { Badge } from "@/components/ui/badge";
import { BlockShell } from "@/components/ui/block-shell";
import { RowButton } from "@/components/ui/row-button";
import { Skeleton } from "@/components/ui/skeleton";
import { TASK_MODAL_STATE, TASK_PANE_PARAM } from "../tasks/task-utils";
import type { Block } from "@dispatch/shared";

/** The assignee by name; the stream's directory has no archived agents. */
function AssigneeName({ id, fallback }: { id: string; fallback: string }) {
  return <>{useAgentRecord(id)?.name?.trim() || fallback}</>;
}

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
      <BlockShell className="my-2 text-body-md text-muted-foreground">
        Task unavailable
        <span className="mt-1 block font-mono text-body-sm">
          {block.data.taskId}
        </span>
      </BlockShell>
    );
  if (isPending || !task)
    return (
      <BlockShell role="status" aria-label="Loading task" className="my-2 h-24">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="mt-2 h-4 w-1/3" />
      </BlockShell>
    );
  const column = board?.columns.find((column) => column.id === task.columnId);
  const done = Boolean(task.completedAt || column?.isDone);
  const Icon = done ? CheckCircle2 : ListTodo;
  return (
    <BlockShell padded={false} className="my-2">
      <RowButton
        aria-haspopup="dialog"
        data-testid="stream-task-card"
        className="min-w-0 items-start gap-3 rounded-none p-3"
        onClick={() => {
          const next = new URLSearchParams(params);
          const paging = next.has("task");
          next.set("task", task.id);
          // Block/thread may still target the agent stream beneath this modal.
          next.set(TASK_PANE_PARAM, "details");
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
          <span className="block break-words text-body-md font-medium">
            {task.title}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-muted-foreground">
            <span>
              {[
                projects.find((project) => project.id === task.projectId)
                  ?.name ?? task.projectId,
                column?.name,
              ]
                .filter(Boolean)
                .join(" · ")}
              {" · "}
              {task.assignedAgentId ? (
                <AssigneeName
                  id={task.assignedAgentId}
                  fallback={agentName(task.assignedAgentId)}
                />
              ) : (
                "Unassigned"
              )}
            </span>
            {done && <Badge>Done</Badge>}
            {task.archivedAt && <Badge tone="warning">Archived</Badge>}
          </span>
        </span>
      </RowButton>
    </BlockShell>
  );
}
