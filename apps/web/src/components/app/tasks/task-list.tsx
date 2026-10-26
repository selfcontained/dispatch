import { useState } from "react";
import type { Task, TaskBoard, TaskColumn } from "@/hooks/use-tasks";
import type { Agent } from "@/components/app/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { TaskAgent } from "./task-agent";
import { TaskLaunching } from "./task-launching";
import { columnAccent, groupTasks, taskAge } from "./task-utils";
import { ColumnTriggerStrip } from "./task-trigger-dialog";
import { ColumnCapacity } from "./task-column-capacity";
import { TaskColumnMenu } from "./task-column-menu";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
export function TaskList({
  board,
  tasks,
  agents,
  openTask,
  moveTask,
  onlyColumnId = null,
}: {
  board: TaskBoard;
  tasks: Task[];
  agents: Agent[];
  openTask: (id: string) => void;
  moveTask: (task: Task, columnId: string) => void;
  /** Show this column's group alone. */
  onlyColumnId?: string | null;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<
    "position" | "age" | "assignee" | "activity"
  >("position");
  const grouped = groupTasks(tasks, board.columns).filter(
    ({ column }) => !onlyColumnId || column.id === onlyColumnId
  );
  const sortTasks = (items: Task[]) =>
    [...items].sort((a, b) =>
      sort === "age"
        ? Date.parse(a.createdAt) - Date.parse(b.createdAt)
        : sort === "assignee"
          ? (
              agents.find((agent) => agent.id === a.assignedAgentId)?.name ?? ""
            ).localeCompare(
              agents.find((agent) => agent.id === b.assignedAgentId)?.name ?? ""
            )
          : sort === "activity"
            ? Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
            : a.position - b.position
    );
  return (
    <div data-testid="tasks-list" className="h-full overflow-auto p-3 md:p-5">
      <div className="mb-3 flex justify-end gap-2">
        <label
          htmlFor="task-sort"
          className="self-center text-xs text-muted-foreground"
        >
          Sort
        </label>
        <Select
          value={sort}
          onValueChange={(value) => setSort(value as typeof sort)}
        >
          <SelectTrigger id="task-sort" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="position">Manual</SelectItem>
            <SelectItem value="age">Age</SelectItem>
            <SelectItem value="assignee">Assignee</SelectItem>
            <SelectItem value="activity">Activity</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {grouped.map(({ column, tasks: group }, index) => (
        <section
          key={column.id}
          id={`task-column-${column.id}`}
          style={
            { "--col": columnAccent(column, index) } as React.CSSProperties
          }
          className="mb-3 overflow-hidden rounded-xl bg-card shadow-sm ring-1 ring-border/40"
        >
          <div className="flex items-center bg-[hsl(var(--col)/0.08)] pr-2">
            <Button
              variant="ghost"
              aria-expanded={!collapsed.has(column.id)}
              className="h-10 min-w-0 flex-1 justify-start gap-2 rounded-none px-3 text-sm font-semibold hover:bg-[hsl(var(--col)/0.14)]"
              onClick={() =>
                setCollapsed((old) => {
                  const next = new Set(old);
                  if (next.has(column.id)) next.delete(column.id);
                  else next.add(column.id);
                  return next;
                })
              }
            >
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  "h-4 w-4 text-muted-foreground transition-transform",
                  collapsed.has(column.id) && "-rotate-90"
                )}
              />
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full bg-[hsl(var(--col))]"
              />
              <span className="min-w-0 truncate">{column.name}</span>
              <ColumnCapacity column={column} />
            </Button>
            <TaskColumnMenu
              column={column}
              board={board}
              orientation="vertical"
            />
          </div>
          <ColumnTriggerStrip column={column} projectId={board.projectId} />
          {!collapsed.has(column.id) && (
            <div className="divide-y divide-border/30">
              {sortTasks(group).map((task) => (
                <div
                  key={task.id}
                  data-testid={`task-row-${task.id}`}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5 px-3 py-2 text-sm transition-colors hover:bg-muted/40 md:grid-cols-[minmax(0,2fr)_minmax(110px,1fr)_minmax(120px,1fr)_55px_minmax(80px,1fr)] md:gap-3"
                >
                  <button
                    className="min-w-0 truncate text-left font-medium hover:underline"
                    onClick={() => openTask(task.id)}
                  >
                    {task.title}
                  </button>
                  <div className="hidden md:block">
                    <StatusSelect
                      task={task}
                      columns={board.columns}
                      moveTask={moveTask}
                    />
                  </div>
                  <div className="hidden md:block">
                    {task.launching ? (
                      <TaskLaunching task={task} columns={board.columns} />
                    ) : (
                      <TaskAgent
                        agent={agents.find(
                          (agent) => agent.id === task.assignedAgentId
                        )}
                        agents={agents}
                        projectId={task.projectId}
                        compact
                      />
                    )}
                  </div>
                  <span className="text-right text-xs text-muted-foreground">
                    {taskAge(task.createdAt)}
                  </span>
                  <div className="col-span-2 flex flex-wrap items-center gap-2 md:col-span-1">
                    {task.latestFailure && !task.launching && (
                      <span
                        className="text-xs text-destructive"
                        title={task.latestFailure.reason}
                      >
                        ⚠ launch failed
                      </span>
                    )}
                    {task.links
                      .filter((link) => link.kind === "pr")
                      .map((link) => (
                        <a
                          key={link.url ?? link.label}
                          href={link.url ?? undefined}
                          className="text-xs text-primary"
                        >
                          {link.label}
                        </a>
                      ))}
                    <div className="flex min-w-0 items-center gap-2 md:hidden">
                      {task.launching ? (
                        <TaskLaunching task={task} columns={board.columns} />
                      ) : (
                        <TaskAgent
                          agent={agents.find(
                            (agent) => agent.id === task.assignedAgentId
                          )}
                          agents={agents}
                          projectId={task.projectId}
                          compact
                        />
                      )}
                    </div>
                    <div className="ml-auto md:hidden">
                      <StatusSelect
                        task={task}
                        columns={board.columns}
                        moveTask={moveTask}
                      />
                    </div>
                  </div>
                </div>
              ))}
              {!group.length && (
                <p className="px-3 py-3 text-xs text-muted-foreground">
                  No tasks
                </p>
              )}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
export function StatusSelect({
  task,
  columns,
  moveTask,
  className,
}: {
  task: Task;
  columns: TaskColumn[];
  moveTask: (task: Task, columnId: string) => void;
  className?: string;
}) {
  return (
    <Select value={task.columnId} onValueChange={(id) => moveTask(task, id)}>
      <SelectTrigger
        aria-label={`Status for ${task.title}`}
        className={cn("h-8 w-32 text-xs", className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {columns.map((column) => (
          <SelectItem key={column.id} value={column.id}>
            {column.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
