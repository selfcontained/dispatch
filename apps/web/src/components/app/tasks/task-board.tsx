import { useEffect, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  closestCorners,
  pointerWithin,
  useDroppable,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type {
  Task,
  TaskBoard as TaskBoardData,
  TaskColumn,
} from "@/hooks/use-tasks";
import type { Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TaskCard, TaskCardOverlay } from "./task-card";
import {
  MENU_ITEM,
  columnAccent,
  orderedColumns,
  tasksInColumn,
} from "./task-utils";
import { MoreHorizontal, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ColumnAutomationStrip,
  TaskAutomationDialog,
} from "./task-automation-dialog";
import { useTaskActions } from "@/hooks/use-tasks";

/**
 * What is under the pointer wins, read from the DOM. dnd-kit's rect-based
 * detection goes wrong on a board that scrolls while a card is lifted: the
 * lifted card's rect is shifted by the scroll since the lift and the
 * columns are measured on pointer moves, so after auto-scroll a finger
 * resting on one column "hovers" another. A hit test at the pointer is
 * exact whatever has scrolled. A card beats its column so ordering within
 * the column still works; nothing under the pointer (the gap between
 * columns, the board's padding) falls back to dnd-kit's own answer.
 */
const underPointer: CollisionDetection = (args) => {
  const point = args.pointerCoordinates;
  if (point && typeof document !== "undefined") {
    let columnId: string | null = null;
    for (const element of document.elementsFromPoint(point.x, point.y)) {
      if (element.closest("[data-testid='task-card-overlay']")) continue;
      const card = element.closest<HTMLElement>("[data-task-id]");
      const id = card?.dataset.taskId ?? null;
      if (id && id !== args.active.id) {
        const container = args.droppableContainers.find((c) => c.id === id);
        if (container)
          return [{ id, data: { droppableContainer: container, value: 0 } }];
      }
      const column = element.closest<HTMLElement>("[data-column-id]");
      if (column?.dataset.columnId) {
        columnId = `${COLUMN_PREFIX}${column.dataset.columnId}`;
        break;
      }
    }
    if (columnId) {
      const container = args.droppableContainers.find((c) => c.id === columnId);
      if (container)
        return [
          { id: columnId, data: { droppableContainer: container, value: 0 } },
        ];
    }
  }
  const hits = pointerWithin(args);
  return hits.length ? hits : closestCorners(args);
};
const COLUMN_PREFIX = "column:";
function BoardColumn({
  column,
  columns,
  tasks,
  agents,
  openTask,
  moveTask,
  addTask,
  projectId,
  dropTarget,
  hidden,
}: {
  column: TaskColumn;
  columns: TaskColumn[];
  tasks: Task[];
  agents: Agent[];
  openTask: (id: string) => void;
  moveTask: (task: Task, columnId: string, beforeId?: string) => void;
  addTask: (columnId: string) => void;
  projectId: string;
  /** A lifted card would land here: over the column or a card in it. */
  dropTarget: boolean;
  /** Filtered out: collapsed to nothing, so the kept column slides over. */
  hidden: boolean;
}) {
  const actions = useTaskActions(projectId);
  const [automation, setAutomation] = useState(false);
  const drop = useDroppable({
    id: `${COLUMN_PREFIX}${column.id}`,
    data: { columnId: column.id },
    disabled: hidden,
  });
  const columnTasks = tasksInColumn(tasks, column.id);
  const index = columns.findIndex((item) => item.id === column.id);
  return (
    <section
      ref={drop.setNodeRef}
      id={`task-column-${column.id}`}
      data-testid={`task-column-${column.key}`}
      data-column-id={column.id}
      data-drop-target={dropTarget ? "true" : undefined}
      aria-hidden={hidden || undefined}
      // Stays mounted so it can fade and fold; inert keeps it out of the
      // tab order meanwhile.
      {...({ inert: hidden ? "" : undefined } as object)}
      style={{ "--col": columnAccent(column, index) } as React.CSSProperties}
      className={cn(
        "flex h-full shrink-0 snap-start flex-col overflow-hidden rounded-xl bg-card shadow-sm ring-1 ring-border/40 transition-[width,opacity,margin,box-shadow] duration-300 ease-out motion-reduce:transition-none",
        hidden
          ? "pointer-events-none -ml-3 w-0 opacity-0 ring-0"
          : "w-[min(300px,calc(100vw-3rem))]",
        dropTarget && "ring-2 ring-[hsl(var(--col)/0.6)]"
      )}
    >
      <header className="flex items-center gap-2 border-t-2 border-[hsl(var(--col)/0.7)] bg-[hsl(var(--col)/0.08)] px-3 py-2">
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full bg-[hsl(var(--col))]"
        />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {column.name}
        </h2>
        <span className="rounded-full bg-background/50 px-1.5 text-xs tabular-nums text-muted-foreground">
          {columnTasks.length}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`${column.name} menu`}
              className="h-7 w-7 text-muted-foreground"
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              className={MENU_ITEM}
              onSelect={() => {
                const name = window.prompt("Column name", column.name);
                if (name?.trim())
                  void actions.updateColumn.mutateAsync({
                    id: column.id,
                    name: name.trim(),
                  });
              }}
            >
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              className={MENU_ITEM}
              onSelect={() => setAutomation(true)}
            >
              {column.trigger ? "Edit automation…" : "Add automation…"}
            </DropdownMenuItem>
            <DropdownMenuItem
              className={MENU_ITEM}
              disabled={index === 0}
              onSelect={() =>
                void actions.updateColumn.mutateAsync({
                  id: column.id,
                  position:
                    index > 1
                      ? (columns[index - 2].position +
                          columns[index - 1].position) /
                        2
                      : columns[0].position - 1,
                })
              }
            >
              Move left
            </DropdownMenuItem>
            <DropdownMenuItem
              className={MENU_ITEM}
              disabled={index === columns.length - 1}
              onSelect={() =>
                void actions.updateColumn.mutateAsync({
                  id: column.id,
                  position:
                    index < columns.length - 2
                      ? (columns[index + 1].position +
                          columns[index + 2].position) /
                        2
                      : columns[columns.length - 1].position + 1,
                })
              }
            >
              Move right
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className={cn(MENU_ITEM, "text-destructive")}
              disabled={columnTasks.length > 0}
              onSelect={() => {
                if (window.confirm(`Delete ${column.name}?`))
                  void actions.removeColumn.mutateAsync(column.id);
              }}
            >
              {columnTasks.length > 0 ? "Delete (empty it first)" : "Delete"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <ColumnAutomationStrip column={column} projectId={projectId} />
      <SortableContext
        items={columnTasks.map((task) => task.id)}
        strategy={verticalListSortingStrategy}
      >
        {/* Only the vertical axis is contained: a sideways wheel or swipe
            over the cards still chains up to scroll the board. */}
        <div className="min-h-16 flex-1 space-y-2 overflow-y-auto overscroll-y-contain px-2 pb-1 pt-2">
          {columnTasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              columns={columns}
              agents={agents}
              onOpen={() => openTask(task.id)}
              onMove={(id) => moveTask(task, id)}
            />
          ))}
        </div>
      </SortableContext>
      <div className="p-2">
        <Button
          variant="ghost"
          className="w-full justify-start text-muted-foreground hover:bg-muted/60"
          onClick={() => addTask(column.id)}
        >
          <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          Add task
        </Button>
      </div>
      <TaskAutomationDialog
        column={column}
        projectId={projectId}
        open={automation}
        onOpenChange={setAutomation}
      />
    </section>
  );
}
export function TaskBoard({
  board,
  tasks,
  agents,
  openTask,
  moveTask,
  addTask,
  onlyColumnId = null,
}: {
  board: TaskBoardData;
  tasks: Task[];
  agents: Agent[];
  openTask: (id: string) => void;
  moveTask: (task: Task, columnId: string, beforeId?: string) => void;
  /** Opens the create form on this column. */
  addTask: (columnId: string) => void;
  /** Show this column alone; the rest fold away. */
  onlyColumnId?: string | null;
}) {
  const columns = orderedColumns(board);
  // A finger drags only after a long press on the grip, so a swipe still
  // scrolls the board; a mouse drags as soon as it moves.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 6 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  // The column a drop would land in, whether the pointer is over the
  // column itself or a card in it.
  const [overColumnId, setOverColumnId] = useState<string | null>(null);
  const activeTask = tasks.find((task) => task.id === activeId);
  const columnOf = (over: DragEndEvent["over"]): string | null => {
    if (!over) return null;
    const id = String(over.id);
    if (id.startsWith(COLUMN_PREFIX)) return id.slice(COLUMN_PREFIX.length);
    return tasks.find((task) => task.id === id)?.columnId ?? null;
  };
  // Nothing on the page selects under a dragging finger.
  useEffect(() => {
    if (!activeId) return;
    const { style } = document.body;
    const previous = style.userSelect;
    style.userSelect = "none";
    style.webkitUserSelect = "none";
    return () => {
      style.userSelect = previous;
      style.webkitUserSelect = previous;
    };
  }, [activeId]);
  const onDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    setOverColumnId(null);
    const active = tasks.find((task) => task.id === event.active.id);
    const over = tasks.find((task) => task.id === event.over?.id);
    const targetId = columnOf(event.over);
    if (
      active &&
      targetId &&
      (active.columnId !== targetId || over?.id !== active.id)
    )
      moveTask(active, targetId, over?.id);
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={underPointer}
      onDragStart={(event) => setActiveId(String(event.active.id))}
      onDragOver={(event) => setOverColumnId(columnOf(event.over))}
      onDragCancel={() => {
        setActiveId(null);
        setOverColumnId(null);
      }}
      onDragEnd={onDragEnd}
    >
      <div
        data-testid="tasks-board"
        data-dragging={activeId ? "true" : undefined}
        className={cn(
          "flex h-full min-h-0 gap-3 overflow-x-auto overscroll-x-contain p-3 scroll-px-3 md:p-4",
          // Snapping fights auto-scroll, so it rests while a card is lifted.
          activeId
            ? "select-none snap-none"
            : "snap-x snap-mandatory md:snap-none"
        )}
      >
        {columns.map((column) => (
          <BoardColumn
            key={column.id}
            column={column}
            columns={columns}
            tasks={tasks}
            agents={agents}
            openTask={openTask}
            moveTask={moveTask}
            addTask={addTask}
            projectId={board.projectId}
            dropTarget={overColumnId === column.id}
            hidden={Boolean(onlyColumnId) && onlyColumnId !== column.id}
          />
        ))}
      </div>
      {/* No drop animation: it scrolls the card's old spot back into view
          to fly there, losing the column it was just dropped in. */}
      <DragOverlay dropAnimation={null}>
        {activeTask ? (
          <TaskCardOverlay task={activeTask} agents={agents} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
