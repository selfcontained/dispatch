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
import { TaskCard, TaskCardOverlay } from "./task-card";
import { columnAccent, orderedColumns, tasksInColumn } from "./task-utils";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { ColumnTriggerStrip } from "./task-trigger-dialog";
import { ColumnCapacity } from "./task-column-capacity";
import { TaskColumnMenu } from "./task-column-menu";

/** Hit-test the scrolled column in the DOM, then its *layout* card slots.
 * Sortable transforms are only a preview: feeding their painted positions
 * back into collision detection makes a stationary pointer alternate targets.
 * Removing the current transform retains live scroll/auto-scroll coordinates.
 */
const underPointer: CollisionDetection = (args) => {
  const point = args.pointerCoordinates;
  if (point && typeof document !== "undefined") {
    const column = document
      .elementsFromPoint(point.x, point.y)
      .filter((el) => !el.closest("[data-testid='task-card-overlay']"))
      .map((el) => el.closest<HTMLElement>("[data-column-id]"))
      .find(Boolean);
    if (column) {
      const cards = Array.from(
        column.querySelectorAll<HTMLElement>("[data-task-id]")
      );
      let id = `${COLUMN_PREFIX}${column.dataset.columnId}`;
      let distance = Infinity;
      for (const card of cards) {
        const rect = card.getBoundingClientRect();
        const transform = getComputedStyle(card).transform;
        const matrix =
          transform === "none" ? null : new DOMMatrixReadOnly(transform);
        const top = rect.top - (matrix?.m42 ?? 0);
        const left = rect.left - (matrix?.m41 ?? 0);
        // Across columns, only a card's layout bounds insert before it.
        // Dropping on column whitespace keeps the existing append behavior.
        if (
          args.active.data.current?.columnId !== column.dataset.columnId &&
          (point.y < top ||
            point.y > top + rect.height ||
            point.x < left ||
            point.x > left + rect.width)
        )
          continue;
        const next = Math.abs(point.y - (top + rect.height / 2));
        if (next < distance) {
          distance = next;
          id = card.dataset.taskId!;
        }
      }
      const container = args.droppableContainers.find((c) => c.id === id);
      if (container)
        return [{ id, data: { droppableContainer: container, value: 0 } }];
    }
  }
  const hits = pointerWithin(args);
  return hits.length ? hits : closestCorners(args);
};
const COLUMN_PREFIX = "column:";
function BoardColumn({
  board,
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
  board: TaskBoardData;
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
        <ColumnCapacity column={column} />
        <TaskColumnMenu
          column={column}
          board={board}
          orientation="horizontal"
        />
      </header>
      <ColumnTriggerStrip column={column} projectId={projectId} />
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
              disabled={hidden}
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
    if (!active || !targetId || over?.id === active.id) return;
    const ordered = tasksInColumn(tasks, targetId);
    let beforeId = over?.id;
    if (active.columnId === targetId && over) {
      // Sortable's downward preview inserts AFTER the hovered slot.
      const from = ordered.findIndex((task) => task.id === active.id);
      const to = ordered.findIndex((task) => task.id === over.id);
      if (from < to) beforeId = ordered[to + 1]?.id;
    }
    const currentNext =
      ordered[ordered.findIndex((task) => task.id === active.id) + 1]?.id;
    if (active.columnId === targetId && currentNext === beforeId) return;
    moveTask(active, targetId, beforeId);
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
            board={board}
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
          <TaskCardOverlay
            task={activeTask}
            columns={columns}
            agents={agents}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
