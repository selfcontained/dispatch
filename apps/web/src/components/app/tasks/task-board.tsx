import { useState } from "react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCorners,
  useDroppable,
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
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TaskCard } from "./task-card";
import { columnAccent, orderedColumns, tasksInColumn } from "./task-utils";
import { MoreHorizontal, Plus, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { TaskAutomationDialog } from "./task-automation-dialog";
import { useTaskActions } from "@/hooks/use-tasks";
/** The app's menu items default to the destructive tint; these are ordinary. */
const MENU_ITEM =
  "text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50";
function BoardColumn({
  column,
  columns,
  tasks,
  agents,
  openTask,
  moveTask,
  projectId,
}: {
  column: TaskColumn;
  columns: TaskColumn[];
  tasks: Task[];
  agents: Agent[];
  openTask: (id: string) => void;
  moveTask: (task: Task, columnId: string, beforeId?: string) => void;
  projectId: string;
}) {
  const actions = useTaskActions(projectId);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [automation, setAutomation] = useState(false);
  const drop = useDroppable({
    id: `column:${column.id}`,
    data: { columnId: column.id },
  });
  const columnTasks = tasksInColumn(tasks, column.id);
  const save = async () => {
    if (!title.trim()) return;
    await actions.create.mutateAsync({
      projectId,
      columnId: column.id,
      title: title.trim(),
    });
    setTitle("");
    setAdding(false);
  };
  const index = columns.findIndex((item) => item.id === column.id);
  return (
    <section
      ref={drop.setNodeRef}
      id={`task-column-${column.id}`}
      data-testid={`task-column-${column.key}`}
      style={{ "--col": columnAccent(column, index) } as React.CSSProperties}
      className={cn(
        "flex h-full w-[min(300px,calc(100vw-3rem))] shrink-0 snap-start flex-col overflow-hidden rounded-xl bg-card shadow-sm ring-1 ring-border/40 transition-shadow",
        drop.isOver && "ring-2 ring-[hsl(var(--col)/0.6)]"
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
        {column.trigger && (
          <span
            title="Automation configured"
            aria-label="Automation configured"
            className="text-[hsl(var(--col))]"
          >
            <Zap className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
        )}
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
              Automation…
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
      <SortableContext
        items={columnTasks.map((task) => task.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="min-h-16 flex-1 space-y-2 overflow-y-auto overscroll-contain px-2 pb-1 pt-2">
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
        {adding ? (
          <Input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
              if (event.key === "Escape") setAdding(false);
            }}
            onBlur={() => {
              if (!title.trim()) setAdding(false);
            }}
            placeholder="Task title"
          />
        ) : (
          <Button
            variant="ghost"
            className="w-full justify-start text-muted-foreground hover:bg-muted/60"
            onClick={() => setAdding(true)}
          >
            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            Add task
          </Button>
        )}
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
}: {
  board: TaskBoardData;
  tasks: Task[];
  agents: Agent[];
  openTask: (id: string) => void;
  moveTask: (task: Task, columnId: string, beforeId?: string) => void;
}) {
  const columns = orderedColumns(board);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const onDragEnd = (event: DragEndEvent) => {
    const active = tasks.find((task) => task.id === event.active.id);
    const over = tasks.find((task) => task.id === event.over?.id);
    const targetId =
      over?.columnId ??
      (typeof event.over?.id === "string" && event.over.id.startsWith("column:")
        ? event.over.id.slice(7)
        : null);
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
      collisionDetection={closestCorners}
      onDragEnd={onDragEnd}
    >
      <div
        data-testid="tasks-board"
        className="flex h-full min-h-0 snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain p-3 scroll-px-3 md:snap-none md:p-4"
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
            projectId={board.projectId}
          />
        ))}
      </div>
    </DndContext>
  );
}
