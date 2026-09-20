/**
 * The drawer's pages, stacked: the home page underneath, and whatever the
 * URL put over it. A new page slides in from the right and pushes the one
 * beneath a little to the left; popping slides it back out. Only the top
 * page is interactive; the rest stay mounted (their scroll positions and
 * drafts survive a peek at a finding) but are hidden from readers.
 */
import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

import { arrive, DURATION } from "@/components/app/chat/turn/motion";
import { cn } from "@/lib/utils";

export type DrawerPage = {
  /** Stable per page: the same key keeps the page mounted across renders. */
  key: string;
  node: ReactNode;
};

/** How far a covered page slides under the one over it. */
const PUSH_PERCENT = 28;

export function DrawerStack({
  pages,
  className,
}: {
  pages: readonly DrawerPage[];
  className?: string;
}): JSX.Element {
  const reduced = useReducedMotion();
  const transition = reduced ? { duration: 0 } : arrive(DURATION.slow);
  const topIndex = pages.length - 1;
  return (
    <div
      className={cn("relative min-h-0 flex-1 overflow-hidden", className)}
      data-testid="drawer-stack"
      data-depth={topIndex}
    >
      <AnimatePresence initial={false}>
        {pages.map((page, index) => {
          const top = index === topIndex;
          return (
            <motion.div
              key={page.key}
              className={cn(
                "absolute inset-0 flex min-h-0 flex-col",
                index > 0 &&
                  "bg-background/95 shadow-[-8px_0_24px_-12px_rgba(0,0,0,0.35)]",
                !top && "pointer-events-none"
              )}
              initial={{ x: "100%" }}
              animate={{
                x: top ? "0%" : `-${PUSH_PERCENT}%`,
                opacity: top ? 1 : 0.4,
              }}
              exit={{ x: "100%", opacity: 1 }}
              transition={transition}
              aria-hidden={top ? undefined : true}
              data-testid="drawer-page"
              data-page-key={page.key}
              data-top={top ? "true" : "false"}
            >
              {page.node}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
