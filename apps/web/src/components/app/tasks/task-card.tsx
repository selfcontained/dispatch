import { TaskLabels } from "./task-labels";
import { useEffect, useRef, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTaskActions } from "@/hooks/use-tasks";
import type { Task, TaskColumn } from "@/hooks/use-tasks";
import type { Agent } from "@/components/app/types";
import { TaskAgent } from "./task-agent";
import { TaskLaunching } from "./task-launching";
import { TaskGoalProgress } from "./task-goal-progress";
import { AgentName } from "@/components/app/agent-name";
import { formatDateTime, formatRelativeCompact } from "@/lib/format";
import { MENU_ITEM } from "./task-utils";
import { TaskMoveSheet } from "./task-move-sheet";
import { GitPullRequest, GripVertical, MoreHorizontal } from "lucide-react";
import {
  ActionMenu,
  ActionMenuContent,
  ActionMenuItem,
  ActionMenuTrigger,
} from "@/components/ui/action-menu";
import { Badge } from "@/components/ui/badge";
import { Chip } from "@/components/ui/chip";
import { IconButton } from "@/components/ui/icon-button";
import { RowButton } from "@/components/ui/row-button";
import { Hint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { archiveTask } from "./task-feedback";

const CARD =
  "group rounded-lg bg-surface-hover p-3 shadow-sm ring-1 ring-foreground/wash pointer-coarse:select-none [-webkit-touch-callout:none]";
// TouchSensor cancels quick swipes and prevents scrolling only after its hold delay.
// Keep native panning available on the grip until then (dnd-kit Touch recommendations).
const GRIP =
  "-ml-2 -mr-1 -mt-0.5 flex size-6 shrink-0 items-center justify-center self-start rounded-sm text-faint touch-manipulation";
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
    // so a keyboard drag cannot land beside it unseen. (A bare boolean
    // would only stop the dragging.)
    disabled: { draggable: disabled, droppable: disabled },
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
  const actions = useTaskActions(task.projectId);
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
        "transition-colors hover:bg-muted focus-ring",
        // Lifted into the drag overlay: what stays is the drop placeholder.
        sortable.isDragging && "opacity-40"
      )}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className="flex gap-2">
        <IconButton
          size="icon-xs"
          label={`Drag ${task.title}`}
          {...sortable.attributes}
          {...sortable.listeners}
          className="-ml-2 -mr-1 -mt-0.5 cursor-grab touch-manipulation self-start text-faint"
        >
          <GripVertical aria-hidden="true" />
        </IconButton>
        <RowButton
          className="relative min-w-0 flex-1 items-start rounded-sm text-body-md font-medium leading-5 hover:bg-transparent pointer-coarse:min-h-0"
          onClick={onOpen}
        >
          <span className="line-clamp-3 min-w-0 break-words">{task.title}</span>
        </RowButton>
        <ActionMenu label="Task actions">
          <ActionMenuTrigger asChild>
            <IconButton
              ref={actionsRef}
              size="icon-sm"
              label={`${task.title} actions`}
              className="-mr-1.5 -mt-1"
            >
              <MoreHorizontal aria-hidden="true" />
            </IconButton>
          </ActionMenuTrigger>
          <ActionMenuContent align="end">
            <ActionMenuItem className={MENU_ITEM} onSelect={onOpen}>
              Open
            </ActionMenuItem>
            <ActionMenuItem
              className={MENU_ITEM}
              onSelect={() => setMoving(true)}
            >
              Move to…
            </ActionMenuItem>
            <ActionMenuItem
              className={MENU_ITEM}
              onSelect={() => archiveTask(actions, task)}
            >
              Archive
            </ActionMenuItem>
          </ActionMenuContent>
        </ActionMenu>
      </div>
      <TaskLabels labels={task.labels} />
      <TaskCardDetails task={task} columns={columns} agents={agents} />
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
  columns,
  agents,
}: {
  task: Task;
  columns: TaskColumn[];
  agents: Agent[];
}) {
  return (
    <article
      data-testid="task-card-overlay"
      className={cn(
        CARD,
        "cursor-grabbing bg-muted shadow-xl ring-2 ring-ring/line"
      )}
    >
      <div className="flex gap-2">
        <span className={GRIP}>
          <GripVertical className="size-icon-sm" aria-hidden="true" />
        </span>
        <span className="line-clamp-3 min-w-0 flex-1 break-words text-body-md font-medium leading-5">
          {task.title}
        </span>
      </div>
      <TaskLabels labels={task.labels} />
      <TaskCardDetails task={task} columns={columns} agents={agents} />
    </article>
  );
}

function TaskCardDetails({
  task,
  columns,
  agents,
}: {
  task: Task;
  columns: TaskColumn[];
  agents: Agent[];
}) {
  const agent = agents.find((item) => item.id === task.assignedAgentId);
  return (
    <>
      <TaskGoalProgress counts={task.goalCounts} className="mt-2" />
      <div className="mt-2 flex flex-wrap items-center gap-2 text-body-sm text-muted-foreground">
        {task.launching ? (
          <TaskLaunching task={task} columns={columns} />
        ) : task.assignedAgentId ? (
          <TaskAgent
            agent={agent}
            agentId={task.assignedAgentId}
            agents={agents}
            projectId={task.projectId}
            fullWidth
          />
        ) : task.createdBy.kind === "agent" ? (
          <span>
            ⚙ by <AgentName agentId={task.createdBy.agentId} />
          </span>
        ) : null}
        <Hint label={formatDateTime(task.createdAt)}>
          <time className="ml-auto">
            {formatRelativeCompact(task.createdAt)}
          </time>
        </Hint>
      </div>
      {(task.links.some((link) => link.kind === "pr") ||
        (task.latestFailure && !task.launching)) && (
        <div className="mt-2 flex flex-wrap gap-1 text-label-sm">
          {task.links
            .filter((link) => link.kind === "pr")
            .map((link) => (
              <a
                key={link.url ?? link.label}
                href={link.url ?? undefined}
                target="_blank"
                rel="noreferrer"
                title={link.label}
                className="inline-flex min-w-0 max-w-full rounded-sm focus-ring"
                onClick={(event) => event.stopPropagation()}
              >
                <Chip size="sm">
                  <GitPullRequest aria-hidden="true" />
                  <span className="min-w-0 truncate">{link.label}</span>
                </Chip>
              </a>
            ))}
          {task.latestFailure && !task.launching && (
            <Badge tone="danger" title={task.latestFailure.reason}>
              <span className="min-w-0 truncate">
                ⚠ launch failed · {task.latestFailure.reason}
              </span>
            </Badge>
          )}
        </div>
      )}
    </>
  );
}
