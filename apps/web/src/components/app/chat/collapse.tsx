import { type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";

import { arrive, DURATION } from "./turn/motion";

/**
 * Every fold in the stream opens and closes the same way: the height eases
 * between 0 and the content's size, the content fades with it. Closed, the
 * content stays mounted (so a review's findings or a thread's replies do
 * not remount and lose their state) but is hidden from readers.
 */
export function Collapse({
  open,
  children,
  className,
  "data-testid": testId,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
}): JSX.Element {
  const reduced = useReducedMotion();
  return (
    <motion.div
      initial={false}
      animate={{ height: open ? "auto" : 0, opacity: open ? 1 : 0 }}
      transition={reduced ? { duration: 0 } : arrive(DURATION.slow)}
      style={{ overflowY: "clip" }}
      aria-hidden={!open}
      className={className}
      data-testid={testId}
      data-open={open ? "true" : "false"}
    >
      {children}
    </motion.div>
  );
}
