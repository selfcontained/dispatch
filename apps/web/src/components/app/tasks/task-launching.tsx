import type { Task, TaskColumn } from "@/hooks/use-tasks";
import { ActivityBars } from "@/components/ui/activity-bars";

export function TaskLaunching({
  task,
  columns,
}: {
  task: Task;
  columns: TaskColumn[];
}) {
  if (!task.launching) return null;
  const name = columns.find((column) => column.id === task.columnId)?.trigger
    ?.templateName;
  return (
    <span
      className="inline-flex min-w-0 items-center gap-2 rounded-full border border-status-working/40 bg-status-working/10 px-2 py-1 text-xs text-foreground shadow-sm"
      data-testid={`task-launching-${task.id}`}
    >
      <ActivityBars size={12} />
      <span className="min-w-0 truncate">Launching {name ?? "agent"}…</span>
    </span>
  );
}
