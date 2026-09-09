import { useState } from "react";
import { ListChecks } from "lucide-react";

import type { TodoItem } from "./registry";
import { TodoList, todoProgress } from "./todo-list";

/** Beyond the active item, how many pending ones show before "more". */
const PREVIEW_PENDING = 3;

/**
 * The agent's current task list, pinned above the composer while there is
 * work left on it: what it is doing now, and what comes next. Long lists
 * show the active item and the next few; the rest is a click away, so the
 * strip never crowds the stream or the composer (nested scrolling is out).
 */
export function TasksStrip({
  items,
  open,
  onOpenChange,
}: {
  items: TodoItem[];
  /** Whether the list is shown; the host keeps it so it survives a re-render. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element | null {
  const [showAll, setShowAll] = useState(false);
  if (items.length === 0) return null;
  const { done, total, active } = todoProgress(items);
  const preview = previewOf(items);
  const shown = showAll ? items : preview;
  const hidden = items.length - preview.length;
  return (
    <div
      className="mb-1.5 rounded-md border border-border/60 bg-muted/50 px-2.5 py-1.5"
      data-testid="harness-tasks"
    >
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-status-working/50 pointer-coarse:min-h-11"
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
            <span className="sr-only">in progress: </span>· {active.content}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <span
          aria-hidden="true"
          className="text-[9px] text-muted-foreground/70"
        >
          {open ? "⏷" : "⏵"}
        </span>
      </button>
      {open ? (
        <>
          <TodoList items={shown} className="mt-1.5 pl-5" />
          {hidden > 0 ? (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="mt-1 pl-5 text-[10.5px] text-muted-foreground hover:text-foreground pointer-coarse:min-h-11"
              data-testid="harness-tasks-more"
            >
              {showAll ? "Show fewer" : `+${hidden} more`}
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** The active item and the next few pending ones, in list order. */
export function previewOf(items: TodoItem[]): TodoItem[] {
  const activeIndex = items.findIndex((i) => i.status === "in_progress");
  const out: TodoItem[] = [];
  let pending = 0;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (i === activeIndex) {
      out.push(item);
      continue;
    }
    if (
      item.status === "pending" &&
      i > activeIndex &&
      pending < PREVIEW_PENDING
    ) {
      out.push(item);
      pending += 1;
    }
  }
  return out.length > 0 ? out : items.slice(0, PREVIEW_PENDING + 1);
}
