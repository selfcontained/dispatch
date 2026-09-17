// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MotionConfig } from "framer-motion";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TodoItem } from "./registry";
import { TodoList } from "./todo-list";

afterEach(cleanup);

const item = (content: string, status: string): TodoItem => ({
  content,
  status,
});

describe("TodoList keys", () => {
  it("keeps a row's node across a reorder instead of remounting it", () => {
    const a = item("a", "pending");
    const b = item("b", "in_progress");
    const c = item("c", "completed");
    const { rerender } = render(
      <MotionConfig reducedMotion="always">
        <TodoList items={[a, b, c]} />
      </MotionConfig>
    );
    const rows = screen.getAllByTestId("harness-todo-item");
    const bRow = rows.find((row) => row.textContent?.includes("b"));
    expect(bRow).toBeTruthy();
    rerender(
      <MotionConfig reducedMotion="always">
        <TodoList items={[c, a, b]} />
      </MotionConfig>
    );
    const rowsAfter = screen.getAllByTestId("harness-todo-item");
    const bRowAfter = rowsAfter.find((row) => row.textContent?.includes("b"));
    expect(bRowAfter).toBe(bRow);
  });

  it("renders duplicate-content rows without a React duplicate-key warning", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const dup = [item("same task", "pending"), item("same task", "pending")];
    render(
      <MotionConfig reducedMotion="always">
        <TodoList items={dup} />
      </MotionConfig>
    );
    expect(screen.getAllByTestId("harness-todo-item")).toHaveLength(2);
    const sameKeyWarning = errorSpy.mock.calls.some((call) =>
      call.some((arg) => typeof arg === "string" && arg.includes("same key"))
    );
    expect(sameKeyWarning).toBe(false);
    errorSpy.mockRestore();
  });
});
