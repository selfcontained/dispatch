import { useState } from "react";
import { ListChecks } from "lucide-react";

import { ComposerStrip } from "../composer-strip";
import { STRIP_MORE_CLASS } from "../composer-strip-styles";

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
  paused = false,
  open,
  onOpenChange,
}: {
  items: TodoItem[];
  /**
   * No turn is running, so nothing on the list is being worked on. The list
   * stays, since the work is still to do, and says that it is waiting.
   */
  paused?: boolean;
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
    <ComposerStrip
      title="Tasks"
      icon={ListChecks}
      summary={`${done} of ${total} done${paused ? " · paused" : ""}`}
      preview={
        active ? (
          <>
            <span className="sr-only">in progress: </span>
            {active.content}
          </>
        ) : undefined
      }
      open={open}
      onOpenChange={onOpenChange}
      testId="harness-tasks"
    >
      <TodoList items={shown} className="mt-1.5 pl-5" />
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className={STRIP_MORE_CLASS}
          data-testid="harness-tasks-more"
        >
          {showAll ? "Show fewer" : `+${hidden} more`}
        </button>
      ) : null}
    </ComposerStrip>
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
