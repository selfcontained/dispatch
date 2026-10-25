// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TaskColumn } from "@/hooks/use-tasks";
import { TaskColumnMenu } from "./task-column-menu";

const updateColumn = vi.fn(async () => {});
vi.mock("@/hooks/use-tasks", () => ({
  useTaskActions: () => ({
    updateColumn: { mutateAsync: updateColumn },
    removeColumn: { mutateAsync: vi.fn() },
  }),
}));
vi.mock("./task-trigger-dialog", () => ({
  TaskTriggerDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog">trigger dialog</div> : null,
}));

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  updateColumn.mockClear();
});

const columns = ["Backlog", "Ready", "Doing", "Done"].map(
  (name, index) =>
    ({
      id: name,
      key: name.toLowerCase(),
      name,
      position: index * 10,
      trigger: null,
    }) as unknown as TaskColumn
);
const openMenu = async (
  column: TaskColumn,
  orientation: "horizontal" | "vertical",
  taskCount = 0
) => {
  render(
    <TaskColumnMenu
      column={column}
      columns={columns}
      projectId="p1"
      taskCount={taskCount}
      orientation={orientation}
    />
  );
  fireEvent.keyDown(
    screen.getByRole("button", { name: `${column.name} menu` }),
    { key: "Enter" }
  );
  await screen.findByRole("menuitem", { name: "Rename" });
};
const item = (name: string) => screen.getByRole("menuitem", { name });

it("stacked columns move up and down with the board's position math", async () => {
  await openMenu(columns[2], "vertical");
  expect(screen.queryByRole("menuitem", { name: "Move left" })).toBeNull();
  fireEvent.click(item("Move up"));
  expect(updateColumn).toHaveBeenCalledWith({ id: "Doing", position: 5 });
  cleanup();
  await openMenu(columns[1], "vertical");
  fireEvent.click(item("Move down"));
  expect(updateColumn).toHaveBeenLastCalledWith({ id: "Ready", position: 25 });
});

it("board columns move left and right; the ends cannot move past", async () => {
  await openMenu(columns[0], "horizontal");
  expect(item("Move left").getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(item("Move right"));
  expect(updateColumn).toHaveBeenCalledWith({ id: "Backlog", position: 15 });
});

it("opens the trigger dialog and only deletes an empty column", async () => {
  await openMenu(columns[1], "vertical", 2);
  expect(item("Delete (empty it first)").getAttribute("aria-disabled")).toBe(
    "true"
  );
  fireEvent.click(item("Add trigger…"));
  expect(await screen.findByRole("dialog")).toBeTruthy();
});
