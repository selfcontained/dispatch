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
import { groupTasks, taskAge } from "./task-utils";
export function TaskList({
  board,
  tasks,
  agents,
  openTask,
  moveTask,
}: {
  board: TaskBoard;
  tasks: Task[];
  agents: Agent[];
  openTask: (id: string) => void;
  moveTask: (task: Task, columnId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<
    "position" | "age" | "assignee" | "activity"
  >("position");
  const grouped = groupTasks(tasks, board.columns);
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
      {grouped.map(({ column, tasks: group }) => (
        <section
          key={column.id}
          className="mb-4 overflow-hidden rounded-lg border border-border/60"
        >
          <Button
            variant="ghost"
            className="w-full justify-start rounded-none bg-muted/40 text-sm"
            onClick={() =>
              setCollapsed((old) => {
                const next = new Set(old);
                if (next.has(column.id)) next.delete(column.id);
                else next.add(column.id);
                return next;
              })
            }
          >
            {collapsed.has(column.id) ? "▸" : "▾"} {column.name}{" "}
            <span className="ml-1 text-muted-foreground">{group.length}</span>
            {column.trigger && <span className="ml-2">⚡</span>}
          </Button>
          {!collapsed.has(column.id) && (
            <div className="divide-y divide-border/40">
              {sortTasks(group).map((task) => (
                <div
                  key={task.id}
                  data-testid={`task-row-${task.id}`}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 p-2 text-sm md:grid-cols-[minmax(0,2fr)_minmax(110px,1fr)_minmax(120px,1fr)_55px_minmax(80px,1fr)] md:gap-3"
                >
                  <button
                    className="truncate text-left font-medium hover:underline"
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
                    <TaskAgent
                      agent={agents.find(
                        (agent) => agent.id === task.assignedAgentId
                      )}
                      projectId={task.projectId}
                      compact
                    />
                  </div>
                  <span className="text-right text-xs text-muted-foreground">
                    {taskAge(task.createdAt)}
                  </span>
                  <div className="col-span-2 flex flex-wrap items-center gap-2 md:col-span-1">
                    {task.latestFailure && (
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
                    <div className="md:hidden">
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
                <p className="p-3 text-xs text-muted-foreground">No tasks</p>
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
}: {
  task: Task;
  columns: TaskColumn[];
  moveTask: (task: Task, columnId: string) => void;
}) {
  return (
    <Select value={task.columnId} onValueChange={(id) => moveTask(task, id)}>
      <SelectTrigger
        aria-label={`Status for ${task.title}`}
        className="h-8 w-32 text-xs"
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
