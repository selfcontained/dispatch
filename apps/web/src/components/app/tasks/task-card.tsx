import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Task, TaskColumn } from "@/hooks/use-tasks";
import type { Agent } from "@/components/app/types";
import { TaskAgent } from "./task-agent";
import { taskAge } from "./task-utils";
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
      className="rounded-lg border border-border/70 bg-card p-3 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className="flex gap-2">
        <button
          type="button"
          {...sortable.attributes}
          {...sortable.listeners}
          className="cursor-grab text-muted-foreground touch-none"
          aria-label={`Drag ${task.title}`}
        >
          ⋮⋮
        </button>
        <button
          className="line-clamp-2 flex-1 text-left text-sm font-medium"
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
        <time title={task.createdAt}>{taskAge(task.createdAt)}</time>
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
                className="rounded bg-muted px-1.5 py-0.5"
                onClick={(event) => event.stopPropagation()}
              >
                {link.label}
              </a>
            ))}
          {task.latestFailure && (
            <span
              className="rounded bg-destructive/15 px-1.5 py-0.5 text-destructive"
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
