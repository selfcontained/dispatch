import { ActivityBars } from "@/components/ui/activity-bars";
import { cn } from "@/lib/utils";

import type { TodoItem } from "./registry";

const STATUS_WORD: Record<string, string> = {
  completed: "completed",
  in_progress: "in progress",
  pending: "pending",
};

/** The agent's task list as the todo tool last wrote it. */
export function TodoList({
  items,
  className,
}: {
  items: TodoItem[];
  className?: string;
}): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <ul
      className={cn("space-y-1 font-terminal text-[11.5px]", className)}
      data-testid="harness-todo-list"
    >
      {items.map((item, i) => {
        const done = item.status === "completed";
        const active = item.status === "in_progress";
        return (
          <li
            key={`${i}:${item.content}`}
            className="flex items-start gap-2"
            data-testid="harness-todo-item"
            data-status={item.status}
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex h-[17px] w-3 shrink-0 items-center justify-center text-[11px] leading-none",
                done
                  ? "font-bold text-status-done"
                  : active
                    ? "text-status-working"
                    : "text-muted-foreground/60"
              )}
            >
              {done ? "✓" : active ? <ActivityBars size={9} /> : "○"}
            </span>
            {/* The glyph and colour say it for sighted readers; this says it aloud. */}
            <span className="sr-only">
              {STATUS_WORD[item.status] ?? item.status}:{" "}
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 leading-[1.5]",
                done
                  ? "text-muted-foreground line-through decoration-muted-foreground/40"
                  : active
                    ? "font-medium text-foreground"
                    : "text-foreground/80"
              )}
            >
              {item.content}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function todoProgress(items: TodoItem[]): {
  done: number;
  total: number;
  active: TodoItem | undefined;
} {
  return {
    done: items.filter((i) => i.status === "completed").length,
    total: items.length,
    active: items.find((i) => i.status === "in_progress"),
  };
}
