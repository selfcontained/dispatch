import type { Task, TaskColumn } from "@/hooks/use-tasks";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Badge } from "@/components/ui/badge";

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
    <Badge
      tone="success"
      className="min-w-0 shrink"
      data-testid={`task-launching-${task.id}`}
    >
      <ActivityBars size={12} />
      <span className="min-w-0 truncate">Launching {name ?? "agent"}…</span>
    </Badge>
  );
}
