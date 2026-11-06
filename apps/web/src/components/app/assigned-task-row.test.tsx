// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AssignedTaskRow } from "./assigned-task-row";
const state = vi.hoisted(() => ({
  assigned: [] as { id: string; projectId: string }[],
  tasks: [] as {
    id: string;
    title: string;
    columnId: string;
    assignedAgentId: string;
    archivedAt: string | null;
  }[],
  columns: [{ id: "c", name: "Custom stage" }],
  isError: false,
}));
vi.mock("@/hooks/use-tasks", () => ({
  useAssignedTasks: () => ({ data: state.assigned, isError: state.isError }),
  useTaskBoard: () => ({
    data: { tasks: state.tasks, columns: state.columns },
    isError: state.isError,
  }),
}));
afterEach(cleanup);
it("tracks current board title/status, hides reassignment/archive/access failures, and keeps first association", () => {
  state.assigned = [
    { id: "one", projectId: "p" },
    { id: "two", projectId: "p" },
  ];
  state.tasks = [
    {
      id: "one",
      title: "First",
      columnId: "c",
      assignedAgentId: "b",
      archivedAt: null,
    },
  ];
  const view = render(
    <MemoryRouter>
      <AssignedTaskRow agentId="b" />
    </MemoryRouter>
  );
  expect(screen.getByRole("button").textContent).toBe("FirstCustom stage");
  state.tasks[0].title = "Renamed";
  state.columns[0].name = "Completed by team";
  view.rerender(
    <MemoryRouter>
      <AssignedTaskRow agentId="b" />
    </MemoryRouter>
  );
  expect(screen.getByRole("button").textContent).toBe(
    "RenamedCompleted by team"
  );
  for (const change of [
    () => {
      state.tasks[0].assignedAgentId = "other";
    },
    () => {
      state.tasks[0].assignedAgentId = "b";
      state.tasks[0].archivedAt = "now";
    },
    () => {
      state.tasks[0].archivedAt = null;
      state.isError = true;
    },
    () => {
      state.isError = false;
      state.assigned = [];
    },
  ]) {
    change();
    view.rerender(
      <MemoryRouter>
        <AssignedTaskRow agentId="b" />
      </MemoryRouter>
    );
    expect(screen.queryByRole("button")).toBeNull();
  }
});
