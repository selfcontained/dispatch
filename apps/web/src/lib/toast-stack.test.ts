import { describe, expect, it, vi } from "vitest";

import { TOAST_PRIORITY, ToastStack, type StackedToast } from "./toast-stack";

const { passing, attention, holds } = TOAST_PRIORITY;

function setup() {
  const shown: string[] = [];
  const display = vi.fn((toast: StackedToast) => {
    if (!shown.includes(toast.key)) shown.push(toast.key);
  });
  const evict = vi.fn((toast: StackedToast) => {
    const index = shown.indexOf(toast.key);
    if (index !== -1) shown.splice(index, 1);
  });
  const stack = new ToastStack(display, evict);
  const push = (key: string, priority: StackedToast["priority"]) =>
    stack.push({ key, priority });
  const close = (key: string) => {
    shown.splice(shown.indexOf(key), 1);
    stack.remove(key);
  };
  return { stack, shown, display, evict, push, close };
}

describe("ToastStack", () => {
  it("never shows more than three", () => {
    const { shown, push } = setup();
    for (const key of ["a", "b", "c", "d", "e"]) push(key, passing);
    expect(shown).toEqual(["c", "d", "e"]);
  });

  it("keeps an error up while passing and attention toasts keep arriving", () => {
    const { shown, push } = setup();
    push("error", holds);
    for (let i = 0; i < 6; i += 1) push(`success-${i}`, passing);
    for (let i = 0; i < 6; i += 1) push(`question-${i}`, attention);
    expect(shown).toContain("error");
    expect(shown).toHaveLength(3);
  });

  it("doesn't drop attention for a success, and shows the success once there's room", () => {
    const { shown, push, close } = setup();
    for (const key of ["a", "b", "c"]) push(key, attention);
    push("saved", passing);
    expect(shown).toEqual(["a", "b", "c"]);
    close("b");
    expect(shown).toEqual(["a", "c", "saved"]);
  });

  it("queues behind three that hold and promotes what matters most", () => {
    const { shown, push, close } = setup();
    for (const key of ["a", "b", "c"]) push(key, holds);
    push("saved", passing);
    push("failed", holds);
    expect(shown).toEqual(["a", "b", "c"]);
    close("a");
    expect(shown).toEqual(["b", "c", "failed"]);
    close("b");
    expect(shown).toEqual(["c", "failed", "saved"]);
  });

  it("drops the stalest passing toast from a burst that is waiting", () => {
    const { shown, evict, push, close } = setup();
    for (const key of ["a", "b", "c"]) push(key, holds);
    for (const key of ["1", "2", "3", "4"]) push(key, passing);
    expect(evict).toHaveBeenCalledWith({ key: "1", priority: passing });
    close("a");
    expect(shown).toEqual(["b", "c", "2"]);
  });

  it("updates one that is showing in place", () => {
    const { shown, display, evict, push } = setup();
    for (const key of ["a", "b", "c"]) push(key, passing);
    push("b", passing);
    expect(shown).toEqual(["a", "b", "c"]);
    expect(display).toHaveBeenCalledTimes(4);
    expect(evict).not.toHaveBeenCalled();
  });
});
