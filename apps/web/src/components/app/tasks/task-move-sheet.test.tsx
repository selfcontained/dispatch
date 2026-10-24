// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Task, TaskColumn } from "@/hooks/use-tasks";
import { TaskMoveSheet } from "./task-move-sheet";

afterEach(cleanup);

const columns = ["Backlog", "In progress", "Done"].map(
  (name, position) =>
    ({
      id: name,
      name,
      key: name,
      position,
      trigger: null,
    }) as unknown as TaskColumn
);
const task = { id: "tsk_1", title: "Ship it", columnId: "Backlog" } as Task;
const renderSheet = () => {
  const onMove = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <TaskMoveSheet
      task={task}
      columns={columns}
      open
      onOpenChange={onOpenChange}
      onMove={onMove}
    />
  );
  return { onMove, onOpenChange };
};

it("lists every column, marks the current one, and moves on a tap", () => {
  const { onMove, onOpenChange } = renderSheet();
  const options = screen.getAllByRole("option");
  expect(options.map((option) => option.textContent)).toEqual([
    "Backlog",
    "In progress",
    "Done",
  ]);
  expect(options[0].getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("option", { name: "In progress" }));
  expect(onMove).toHaveBeenCalledWith("In progress");
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("closes without moving when the current column is picked", () => {
  const { onMove, onOpenChange } = renderSheet();
  fireEvent.click(screen.getByRole("option", { name: /Backlog/ }));
  expect(onMove).not.toHaveBeenCalled();
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
