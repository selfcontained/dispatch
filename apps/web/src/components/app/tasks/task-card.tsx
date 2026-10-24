import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Task, TaskColumn } from "@/hooks/use-tasks";
import type { Agent } from "@/components/app/types";
import { TaskAgent } from "./task-agent";
import { taskAge } from "./task-utils";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
export function TaskCard({
  task,
  columns,
  agents,
  onOpen,
  onMove,
}: {
  task: Task;
  columns: TaskColumn[];
  agents: Agent[];
  onOpen: () => void;
  onMove: (columnId: string) => void;
}) {
  const sortable = useSortable({
    id: task.id,
    data: { columnId: task.columnId },
  });
  const agent = agents.find((item) => item.id === task.assignedAgentId);
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "[" && event.key !== "]") return;
    const index = columns.findIndex((column) => column.id === task.columnId);
    const target = columns[index + (event.key === "[" ? -1 : 1)];
    if (target) {
      event.preventDefault();
      onMove(target.id);
    }
  };
  return (
    <article
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      data-testid={`task-card-${task.id}`}
      className={cn(
        "group rounded-lg bg-muted/70 p-3 shadow-sm ring-1 ring-foreground/[0.05] transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        sortable.isDragging && "relative z-10 shadow-lg"
      )}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className="flex gap-2">
        <button
          type="button"
          {...sortable.attributes}
          {...sortable.listeners}
          className="-ml-1 cursor-grab self-start rounded text-muted-foreground/50 touch-none hover:text-foreground"
          aria-label={`Drag ${task.title}`}
        >
          <GripVertical className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          className="line-clamp-3 min-w-0 flex-1 break-words text-left text-sm font-medium leading-5"
          onClick={onOpen}
        >
          {task.title}
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {task.assignedAgentId ? (
          <TaskAgent agent={agent} projectId={task.projectId} />
        ) : task.createdBy.kind === "agent" ? (
          <span>
            ⚙ by{" "}
            {agents.find(
              (item) =>
                item.id ===
                (task.createdBy.kind === "agent" ? task.createdBy.agentId : "")
            )?.name ?? task.createdBy.agentId}
          </span>
        ) : null}
        <time className="ml-auto" title={task.createdAt}>
          {taskAge(task.createdAt)}
        </time>
      </div>
      {(task.links.some((link) => link.kind === "pr") ||
        task.latestFailure) && (
        <div className="mt-2 flex flex-wrap gap-1 text-[11px]">
          {task.links
            .filter((link) => link.kind === "pr")
            .map((link) => (
              <a
                key={link.url ?? link.label}
                href={link.url ?? undefined}
                target="_blank"
                rel="noreferrer"
                className="rounded bg-background/60 px-1.5 py-0.5"
                onClick={(event) => event.stopPropagation()}
              >
                {link.label}
              </a>
            ))}
          {task.latestFailure && (
            <span
              className="max-w-full truncate rounded bg-destructive/15 px-1.5 py-0.5 text-destructive"
              title={task.latestFailure.reason}
            >
              ⚠ launch failed · {task.latestFailure.reason}
            </span>
          )}
        </div>
      )}
    </article>
  );
}
