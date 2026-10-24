// @vitest-environment jsdom
import { useRef, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
      returnFocus={vi.fn()}
    />
  );
  return { onMove, onOpenChange };
};
// Opened from a card's ⋯ menu, which the sheet doesn't know about.
function FromMenu() {
  const [open, setOpen] = useState(true);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={trigger}>Ship it actions</button>
      <TaskMoveSheet
        task={task}
        columns={columns}
        open={open}
        onOpenChange={setOpen}
        onMove={vi.fn()}
        returnFocus={() => trigger.current?.focus()}
      />
    </>
  );
}

it("lists every column, marks the current one, and moves on a tap", () => {
  const { onMove, onOpenChange } = renderSheet();
  const group = screen.getByRole("group", { name: "Columns" });
  expect(within(group).getAllByRole("button")).toEqual([
    within(group).getByRole("button", { name: "Backlog, current column" }),
    within(group).getByRole("button", { name: "In progress" }),
    within(group).getByRole("button", { name: "Done" }),
  ]);
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "In progress" }));
  expect(onMove).toHaveBeenCalledWith("In progress");
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("closes without moving when the current column is picked", () => {
  const { onMove, onOpenChange } = renderSheet();
  fireEvent.click(
    screen.getByRole("button", { name: "Backlog, current column" })
  );
  expect(onMove).not.toHaveBeenCalled();
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("returns focus to the card's actions on Escape", async () => {
  render(<FromMenu />);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Ship it actions" })
  );
});

it("returns focus to the card's actions when the current column is picked", async () => {
  render(<FromMenu />);
  fireEvent.click(
    screen.getByRole("button", { name: "Backlog, current column" })
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Ship it actions" })
  );
});
