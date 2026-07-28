import type { ComponentType, ReactNode } from "react";

/**
 * Factory for a framer-motion module mock that strips the animation layer so
 * animated subtrees mount/unmount synchronously in jsdom. Use from a test
 * file's hoisted vi.mock factory:
 *
 *   vi.mock("framer-motion", async (importOriginal) => {
 *     const { createFramerMotionMock } = await import(
 *       "@/test-utils/framer-motion-mock"
 *     );
 *     return createFramerMotionMock(importOriginal);
 *   });
 *
 * Motion components are cached per tag so their identity is stable across
 * renders — a fresh component per property access would make React remount
 * (and reset the state of) the animated subtree on every re-render.
 */
export async function createFramerMotionMock(
  importOriginal: () => Promise<Record<string, unknown>>
): Promise<Record<string, unknown>> {
  const actual = await importOriginal();
  const React = await import("react");
  const MOTION_ONLY_PROPS = new Set([
    "layout",
    "layoutId",
    "initial",
    "animate",
    "exit",
    "transition",
    "variants",
  ]);
  const cache = new Map<string, ComponentType<Record<string, unknown>>>();
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        if (!cache.has(tag)) {
          cache.set(
            tag,
            React.forwardRef<HTMLElement, Record<string, unknown>>(
              (props, ref) => {
                const domProps = Object.fromEntries(
                  Object.entries(props).filter(
                    ([key]) => !MOTION_ONLY_PROPS.has(key)
                  )
                );
                return React.createElement(tag, { ...domProps, ref });
              }
            ) as unknown as ComponentType<Record<string, unknown>>
          );
        }
        return cache.get(tag);
      },
    }
  );
  return {
    ...actual,
    motion,
    AnimatePresence: ({ children }: { children?: ReactNode }) => children,
  };
}
