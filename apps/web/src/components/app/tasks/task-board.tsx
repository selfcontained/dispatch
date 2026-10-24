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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TaskCard } from "./task-card";
import { orderedColumns, tasksInColumn } from "./task-utils";
import { TaskAutomationDialog } from "./task-automation-dialog";
import { useTaskActions } from "@/hooks/use-tasks";
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
      data-testid={`task-column-${column.key}`}
      className="flex h-full w-[290px] min-w-[290px] snap-start flex-col rounded-xl border border-border/60 bg-muted/25"
    >
      <header className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {column.name}{" "}
          <span className="text-muted-foreground">{columnTasks.length}</span>
        </h2>
        {column.trigger && <span title="Automation configured">⚡</span>}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`${column.name} menu`}
              className="h-7 w-7"
            >
              ⋯
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
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
            <DropdownMenuItem onSelect={() => setAutomation(true)}>
              Automation…
            </DropdownMenuItem>
            <DropdownMenuItem
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
            <DropdownMenuItem
              disabled={columnTasks.length > 0}
              onSelect={() => {
                if (window.confirm(`Delete ${column.name}?`))
                  void actions.removeColumn.mutateAsync(column.id);
              }}
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <SortableContext
        items={columnTasks.map((task) => task.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="min-h-16 flex-1 space-y-2 overflow-y-auto p-2">
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
            className="w-full justify-start text-muted-foreground"
            onClick={() => setAdding(true)}
          >
            + Add task
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
        className="flex h-full min-h-0 gap-3 overflow-x-auto p-4 snap-x"
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
