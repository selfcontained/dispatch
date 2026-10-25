// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Task, TaskBoard, TaskColumn } from "@/hooks/use-tasks";
import { TaskColumnMenu } from "./task-column-menu";

const archiveColumn = vi.fn(async () => ({}));
const updateColumn = vi.fn(async () => {});
vi.mock("@/hooks/use-tasks", () => ({
  useTaskActions: () => ({
    archiveColumn: { mutateAsync: archiveColumn },
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
  archiveColumn.mockClear();
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
  tasks: Task[] = []
) => {
  // Shuffled: the menu orders the board's columns itself.
  const board = {
    projectId: "p1",
    columns: [...columns].reverse(),
    tasks,
  } as TaskBoard;
  render(
    <TaskColumnMenu column={column} board={board} orientation={orientation} />
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
  // Counted on the whole board, so a search hiding the tasks cannot
  // offer a delete the server refuses.
  await openMenu(columns[1], "vertical", [
    { id: "t1", columnId: "Ready" } as Task,
  ]);
  expect(item("Delete (empty it first)").getAttribute("aria-disabled")).toBe(
    "true"
  );
  fireEvent.click(item("Add trigger…"));
  expect(await screen.findByRole("dialog")).toBeTruthy();
});

it("offers archive only for completion columns and confirms the whole board count", async () => {
  await openMenu({ ...columns[3], isDone: true }, "horizontal", [
    { id: "t1", columnId: "Done", archivedAt: null } as Task,
    { id: "t2", columnId: "Done", archivedAt: null } as Task,
    { id: "old", columnId: "Done", archivedAt: "2026-01-01" } as Task,
    { id: "other", columnId: "Ready", archivedAt: null } as Task,
  ]);
  fireEvent.click(item("Archive 2 tasks"));
  expect(await screen.findByRole("alertdialog")).toBeTruthy();
  expect(screen.getByText("Archive 2 tasks from Done?")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Archive 2 tasks" }));
  expect(archiveColumn).toHaveBeenCalledWith("Done");
});

it("disables empty completion archive and hides archive on other columns", async () => {
  await openMenu({ ...columns[3], isDone: true }, "vertical");
  expect(item("Archive 0 tasks").getAttribute("aria-disabled")).toBe("true");
  cleanup();
  await openMenu({ ...columns[1], isDone: false }, "vertical");
  expect(screen.queryByRole("menuitem", { name: /Archive/ })).toBeNull();
});

it("returns focus to the column menu after cancelling or confirming archive", async () => {
  const done = { ...columns[3], isDone: true };
  await openMenu(done, "horizontal", [
    { id: "t1", columnId: "Done", archivedAt: null } as Task,
  ]);
  const menuButton = screen.getByRole("button", {
    name: "Done menu",
    hidden: true,
  });
  fireEvent.click(item("Archive 1 task"));
  await screen.findByRole("alertdialog");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(menuButton));

  fireEvent.keyDown(menuButton, { key: "Enter" });
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Archive 1 task" })
  );
  await screen.findByRole("alertdialog");
  fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(menuButton));

  fireEvent.keyDown(menuButton, { key: "Enter" });
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Archive 1 task" })
  );
  await screen.findByRole("alertdialog");
  fireEvent.click(screen.getByRole("button", { name: "Archive 1 task" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(menuButton));
});

it("uses singular wording for one task", async () => {
  await openMenu({ ...columns[3], isDone: true }, "horizontal", [
    { id: "one", columnId: "Done", archivedAt: null } as Task,
  ]);
  fireEvent.click(item("Archive 1 task"));
  expect(await screen.findByText("Archive 1 task from Done?")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Archive 1 task" })).toBeTruthy();
});
