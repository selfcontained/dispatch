import type { Task, TaskBoard, TaskColumn } from "@/hooks/use-tasks";
export type TaskView = "all" | "attention" | "working" | "agents" | "done";
export function orderedColumns(board: TaskBoard): TaskColumn[] {
  return [...board.columns].sort((a, b) => a.position - b.position);
}
export function tasksInColumn(tasks: Task[], columnId: string): Task[] {
  return tasks
    .filter((task) => task.columnId === columnId)
    .sort((a, b) => a.position - b.position);
}
export function nextPosition(
  tasks: Task[],
  columnId: string,
  beforeId?: string
): number {
  const ordered = tasksInColumn(tasks, columnId);
  if (!ordered.length) return 0;
  if (!beforeId) return ordered[ordered.length - 1].position + 1;
  const index = ordered.findIndex((task) => task.id === beforeId);
  if (index < 0) return ordered[ordered.length - 1].position + 1;
  return index === 0
    ? ordered[0].position - 1
    : (ordered[index - 1].position + ordered[index].position) / 2;
}
export function visibleTasks(
  tasks: Task[],
  columns: TaskColumn[],
  view: TaskView,
  attentionIds: Set<string>,
  workingIds: Set<string>
): Task[] {
  const doneIds = new Set(
    columns.filter((column) => column.isDone).map((column) => column.id)
  );
  const weekAgo = Date.now() - 7 * 86400000;
  return tasks.filter((task) => {
    if (view === "attention")
      return (
        !!task.latestFailure ||
        (!!task.assignedAgentId && attentionIds.has(task.assignedAgentId))
      );
    if (view === "working")
      return !!task.assignedAgentId && workingIds.has(task.assignedAgentId);
    if (view === "agents") return task.createdBy.kind === "agent";
    if (view === "done")
      return (
        doneIds.has(task.columnId) &&
        !!task.completedAt &&
        Date.parse(task.completedAt) > weekAgo
      );
    return (
      !doneIds.has(task.columnId) ||
      !task.completedAt ||
      Date.parse(task.completedAt) > weekAgo
    );
  });
}
export function groupTasks(
  tasks: Task[],
  columns: TaskColumn[]
): Array<{ column: TaskColumn; tasks: Task[] }> {
  return orderedColumns({ columns, tasks, projectId: "" }).map((column) => ({
    column,
    tasks: tasksInColumn(tasks, column.id),
  }));
}
export function taskAge(date: string): string {
  const days = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(date)) / 86400000)
  );
  if (days) return `${days}d`;
  const hours = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(date)) / 3600000)
  );
  return hours ? `${hours}h` : "now";
}
