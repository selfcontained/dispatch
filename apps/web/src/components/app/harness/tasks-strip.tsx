import { useState } from "react";
import { ListChecks } from "lucide-react";

import { cn } from "@/lib/utils";

import type { TodoItem } from "./registry";
import { TodoList, todoProgress } from "./todo-list";

/**
 * The agent's current task list, pinned above the composer while there is
 * work left on it: what it is doing now, and what comes next.
 */
export function TasksStrip({
  items,
}: {
  items: TodoItem[];
}): JSX.Element | null {
  const [open, setOpen] = useState(true);
  if (items.length === 0) return null;
  const { done, total, active } = todoProgress(items);
  return (
    <div
      className="mb-1.5 rounded-md border border-border/60 bg-muted/50 px-2.5 py-1.5"
      data-testid="harness-tasks"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-status-working/50"
        data-testid="harness-tasks-toggle"
      >
        <ListChecks
          className="h-3 w-3 shrink-0 text-status-working"
          aria-hidden="true"
        />
        <span className="text-[11px] font-medium text-foreground">Tasks</span>
        <span className="text-[10.5px] tabular-nums text-muted-foreground">
          {done} of {total} done
        </span>
        {!open && active ? (
          <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/80">
            · {active.content}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <span
          aria-hidden="true"
          className={cn("text-[9px] text-muted-foreground/70")}
        >
          {open ? "⏷" : "⏵"}
        </span>
      </button>
      {open ? <TodoList items={items} className="mt-1.5 pl-5" /> : null}
    </div>
  );
}
