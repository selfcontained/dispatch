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
    goalCounts?: { completed: number; total: number };
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

it("shows goal progress for the row's task and none without current goals", () => {
  state.isError = false;
  state.columns = [{ id: "c", name: "In progress" }];
  state.assigned = [{ id: "g", projectId: "p" }];
  state.tasks = [
    {
      id: "g",
      title: "Goals",
      columnId: "c",
      assignedAgentId: "b",
      archivedAt: null,
      goalCounts: { completed: 2, total: 3 },
    },
  ];
  const view = render(
    <MemoryRouter>
      <AssignedTaskRow agentId="b" />
    </MemoryRouter>
  );
  expect(screen.getByRole("button").getAttribute("aria-label")).toBe(
    "Task: Goals, In progress, 2 of 3 goals complete"
  );
  expect(screen.getByTestId("task-goal-progress").textContent).toBe(
    "2 of 3 goals complete"
  );
  state.tasks[0].goalCounts = { completed: 0, total: 0 };
  view.rerender(
    <MemoryRouter>
      <AssignedTaskRow agentId="b" />
    </MemoryRouter>
  );
  expect(screen.queryByTestId("task-goal-progress")).toBeNull();
  expect(screen.getByRole("button").getAttribute("aria-label")).toBe(
    "Task: Goals, In progress"
  );
});

it("does not celebrate when a different task takes over the row", () => {
  state.isError = false;
  state.columns = [{ id: "c", name: "In progress" }];
  state.assigned = [{ id: "x", projectId: "p" }];
  state.tasks = [
    {
      id: "x",
      title: "Old",
      columnId: "c",
      assignedAgentId: "b",
      archivedAt: null,
      goalCounts: { completed: 1, total: 3 },
    },
  ];
  const view = render(
    <MemoryRouter>
      <AssignedTaskRow agentId="b" />
    </MemoryRouter>
  );
  state.assigned = [{ id: "y", projectId: "p" }];
  state.tasks = [
    {
      id: "y",
      title: "New",
      columnId: "c",
      assignedAgentId: "b",
      archivedAt: null,
      goalCounts: { completed: 3, total: 3 },
    },
  ];
  view.rerender(
    <MemoryRouter>
      <AssignedTaskRow agentId="b" />
    </MemoryRouter>
  );
  expect(screen.getByText("3 of 3 goals complete")).toBeTruthy();
  expect(screen.queryByTestId("goal-complete-sweep")).toBeNull();
});
