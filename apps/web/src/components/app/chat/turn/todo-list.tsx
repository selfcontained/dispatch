import { AnimatePresence, motion } from "framer-motion";

import { ActivityBars } from "@/components/ui/activity-bars";
import { cn } from "@/lib/utils";
import {
  STRIP_ITEM_CLASS,
  STRIP_LIST_CLASS,
  STRIP_ROW_CLASS,
  STRIP_STATUS_CLASS,
} from "../composer-strip-styles";

import { arrive, DURATION, fadeVariants } from "./motion";
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
  // Stable keys from content (with a duplicate counter for repeats), so a
  // reorder or mid-list removal lets `layout` animate rows into place
  // instead of remounting them under a shifted index-based key.
  const seen = new Map<string, number>();
  const keyed = items.map((item) => {
    const n = seen.get(item.content) ?? 0;
    seen.set(item.content, n + 1);
    return { item, key: n === 0 ? item.content : `${item.content}#${n}` };
  });
  return (
    <ul
      className={cn(STRIP_LIST_CLASS, className)}
      data-testid="harness-todo-list"
    >
      {keyed.map(({ item, key }) => {
        const done = item.status === "completed";
        const active = item.status === "in_progress";
        return (
          <motion.li
            key={key}
            layout
            transition={arrive()}
            className={STRIP_ROW_CLASS}
            data-testid="harness-todo-item"
            data-status={item.status}
          >
            <span
              aria-hidden="true"
              className={cn(
                STRIP_STATUS_CLASS,
                done
                  ? "font-bold text-status-done"
                  : active
                    ? "text-status-working"
                    : "text-muted-foreground/60"
              )}
            >
              <AnimatePresence mode="wait">
                <motion.span
                  key={item.status}
                  variants={fadeVariants}
                  initial="hidden"
                  animate="shown"
                  exit="hidden"
                  transition={arrive(DURATION.fast)}
                >
                  {done ? "✓" : active ? <ActivityBars size={9} /> : "○"}
                </motion.span>
              </AnimatePresence>
            </span>
            {/* The glyph and color say it for sighted readers; this says it aloud. */}
            <span className="sr-only">
              {STATUS_WORD[item.status] ?? item.status}:{" "}
            </span>
            <span
              className={cn(
                STRIP_ITEM_CLASS,
                done
                  ? "text-muted-foreground line-through decoration-muted-foreground/40"
                  : active
                    ? "font-medium text-foreground"
                    : "text-foreground/80"
              )}
            >
              {item.content}
            </span>
          </motion.li>
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
