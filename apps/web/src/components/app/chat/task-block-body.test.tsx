// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { TaskBlockBody } from "./task-block-body";
import type { Block } from "@dispatch/shared";
const query = vi.hoisted(() => ({
  data: {
    id: "tsk_012345abcdef",
    title: "Ship task cards",
    projectId: "p1",
    columnId: "done",
    assignedAgentId: "agt_1",
    archivedAt: "today",
    completedAt: "today",
  } as Record<string, unknown> | undefined,
  error: null as Error | null,
  isPending: false,
}));
vi.mock("@/hooks/use-tasks", () => ({
  useTaskDetail: () => query,
  useTaskBoard: () => ({
    data: { columns: [{ id: "done", name: "Completed", isDone: true }] },
  }),
}));
vi.mock("@/hooks/use-projects", () => ({
  useProjects: () => ({ data: [{ id: "p1", name: "Dispatch" }] }),
}));
afterEach(() => {
  cleanup();
  query.error = null;
  query.isPending = false;
});
const block = { kind: "task", data: { taskId: "tsk_012345abcdef" } } as Extract<
  Block,
  { kind: "task" }
>;
function Location() {
  const location = useLocation();
  return <output>{location.search}</output>;
}
function View() {
  return (
    <MemoryRouter initialEntries={["/agents?project=p1"]}>
      <TaskBlockBody block={block} agentName={() => "Builder"} />
      <Location />
    </MemoryRouter>
  );
}
it("shows live fields, archived and done state and opens the existing task URL", () => {
  const { rerender } = render(<View />);
  const card = screen.getByRole("button", { name: /Ship task cards/ });
  expect(card.getAttribute("aria-haspopup")).toBe("dialog");
  for (const field of ["Dispatch", "Completed", "Builder", "Done", "Archived"])
    expect(card.textContent).toContain(field);
  fireEvent.click(card);
  expect(screen.getByRole("status").textContent).toContain(
    "task=tsk_012345abcdef"
  );
  query.data = { ...query.data, title: "Updated title" };
  rerender(<View />);
  expect(screen.getByRole("button").textContent).toContain("Updated title");
});
it("replaces cached task fields with a safe unavailable state on error", () => {
  query.error = new Error("404");
  render(<View />);
  expect(screen.getByText("Task unavailable")).toBeTruthy();
  expect(screen.getByText(block.data.taskId)).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByText("Updated title")).toBeNull();
});
it("reserves space while loading", () => {
  query.isPending = true;
  render(<View />);
  expect(
    screen.getByRole("status", { name: "Loading task" }).className
  ).toContain("h-24");
});
