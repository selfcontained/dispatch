import {
  type ComponentPropsWithoutRef,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { motion, useReducedMotion } from "framer-motion";

import { arrive } from "./motion";

/**
 * A wrapper whose height eases to whatever its content measures. A step row
 * landing, the thinking row coming and going, an answer streaming in, the
 * rail folding on settle: each is a size change that would otherwise snap,
 * and with the feed following the bottom, snap everything above it.
 *
 * The height is read from a ResizeObserver on the content, never from the
 * wrapper, which is the node being driven. Overflow is clipped only while a
 * transition runs, so a focus ring or a menu opening out of a row is not cut
 * off at rest. Without a ResizeObserver (older WebKit, jsdom) the wrapper
 * stays `auto` and the content sizes itself as before.
 */
export function AutoHeight({
  children,
  ...rest
}: { children: ReactNode } & Omit<
  ComponentPropsWithoutRef<typeof motion.div>,
  "children" | "animate" | "initial" | "transition"
>): JSX.Element {
  const content = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [moving, setMoving] = useState(false);
  const reduced = useReducedMotion();

  useLayoutEffect(() => {
    const el = content.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      // borderBoxSize is what the wrapper has to reach; contentRect leaves
      // the content's own padding out.
      const box = entry.borderBoxSize?.[0];
      setHeight(box ? box.blockSize : entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <motion.div
      {...rest}
      initial={false}
      animate={{ height: height ?? "auto" }}
      transition={reduced ? { duration: 0 } : arrive()}
      onAnimationStart={() => setMoving(true)}
      onAnimationComplete={() => setMoving(false)}
      style={{ ...rest.style, overflow: moving ? "hidden" : undefined }}
    >
      <div ref={content}>{children}</div>
    </motion.div>
  );
}
