import { useEffect, useRef, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Task, TaskColumn } from "@/hooks/use-tasks";
import type { Agent } from "@/components/app/types";
import { TaskAgent } from "./task-agent";
import { MENU_ITEM, taskAge } from "./task-utils";
import { TaskMoveSheet } from "./task-move-sheet";
import { GripVertical, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const CARD =
  "group rounded-lg bg-muted/70 p-3 shadow-sm ring-1 ring-foreground/[0.05] pointer-coarse:select-none [-webkit-touch-callout:none]";
const GRIP =
  "-ml-1 self-start rounded text-muted-foreground/50 touch-none pointer-coarse:-my-2 pointer-coarse:-ml-2.5 pointer-coarse:p-2.5";
/**
 * A card moved from its Move to… sheet remounts in its new column; that
 * mount takes focus back, as the sheet can't reach the new card.
 */
let focusOnMount: { taskId: string; until: number } | null = null;

export function TaskCard({
  task,
  columns,
  agents,
  onOpen,
  onMove,
  disabled = false,
}: {
  task: Task;
  columns: TaskColumn[];
  agents: Agent[];
  onOpen: () => void;
  onMove: (columnId: string) => void;
  /** In a filtered-out column: not draggable, not a drop target. */
  disabled?: boolean;
}) {
  const sortable = useSortable({
    id: task.id,
    data: { columnId: task.columnId },
    // A card in a filtered-out column is neither draggable nor a target,
    // so a keyboard drag cannot land beside it unseen.
    disabled,
  });
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "[" && event.key !== "]") return;
    const index = columns.findIndex((column) => column.id === task.columnId);
    const target = columns[index + (event.key === "[" ? -1 : 1)];
    if (target) {
      event.preventDefault();
      onMove(target.id);
    }
  };
  const [moving, setMoving] = useState(false);
  const actionsRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusOnMount?.taskId !== task.id) return;
    // A refused move (relaunch confirmation) never remounts: let it lapse.
    if (Date.now() < focusOnMount.until) actionsRef.current?.focus();
    focusOnMount = null;
  }, [task.id]);
  return (
    <article
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      data-testid={`task-card-${task.id}`}
      data-task-id={task.id}
      className={cn(
        CARD,
        "transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        // Lifted into the drag overlay: what stays is the drop placeholder.
        sortable.isDragging && "opacity-40"
      )}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className="flex gap-2">
        <button
          type="button"
          {...sortable.attributes}
          {...sortable.listeners}
          className={cn(GRIP, "cursor-grab hover:text-foreground")}
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              ref={actionsRef}
              size="icon"
              variant="ghost"
              aria-label={`${task.title} actions`}
              className="-mr-1.5 -mt-1 h-7 w-7 shrink-0 text-muted-foreground pointer-coarse:h-9 pointer-coarse:w-9"
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem className={MENU_ITEM} onSelect={onOpen}>
              Open
            </DropdownMenuItem>
            <DropdownMenuItem
              className={MENU_ITEM}
              onSelect={() => setMoving(true)}
            >
              Move to…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <TaskCardDetails task={task} agents={agents} />
      <TaskMoveSheet
        task={task}
        columns={columns}
        open={moving}
        onOpenChange={setMoving}
        onMove={(columnId) => {
          focusOnMount = { taskId: task.id, until: Date.now() + 2000 };
          onMove(columnId);
        }}
        returnFocus={() => actionsRef.current?.focus()}
      />
    </article>
  );
}

/** The card as it rides under a finger or pointer while dragging. */
export function TaskCardOverlay({
  task,
  agents,
}: {
  task: Task;
  agents: Agent[];
}) {
  return (
    <article
      data-testid="task-card-overlay"
      className={cn(
        CARD,
        "cursor-grabbing bg-muted shadow-xl ring-2 ring-ring/40"
      )}
    >
      <div className="flex gap-2">
        <span className={GRIP}>
          <GripVertical className="h-4 w-4" aria-hidden="true" />
        </span>
        <span className="line-clamp-3 min-w-0 flex-1 break-words text-sm font-medium leading-5">
          {task.title}
        </span>
      </div>
      <TaskCardDetails task={task} agents={agents} />
    </article>
  );
}

function TaskCardDetails({ task, agents }: { task: Task; agents: Agent[] }) {
  const agent = agents.find((item) => item.id === task.assignedAgentId);
  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {task.assignedAgentId ? (
          <TaskAgent
            agent={agent}
            agents={agents}
            projectId={task.projectId}
            fullWidth
          />
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
    </>
  );
}
