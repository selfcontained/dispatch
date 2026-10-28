// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
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
  const navigate = useNavigate();
  return (
    <>
      <output data-modal={location.state?.taskModal}>{location.search}</output>
      <button onClick={() => navigate(-1)}>Back</button>
      <button onClick={() => navigate(1)}>Forward</button>
    </>
  );
}
function View({ entry = "/agents?project=p1" }: { entry?: string }) {
  return (
    <MemoryRouter initialEntries={["/before", entry]} initialIndex={1}>
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
  expect(screen.getByRole("button", { name: /Updated title/ })).toBeTruthy();
});
it("replaces cached task fields with a safe unavailable state on error", () => {
  query.error = new Error("404");
  render(<View />);
  expect(screen.getByText("Task unavailable")).toBeTruthy();
  expect(screen.getByText(block.data.taskId)).toBeTruthy();
  expect(screen.queryByTestId("stream-task-card")).toBeNull();
  expect(screen.queryByText("Updated title")).toBeNull();
});
it("reserves space while loading", () => {
  query.isPending = true;
  render(<View />);
  expect(
    screen.getByRole("status", { name: "Loading task" }).className
  ).toContain("h-24");
});

it.each(["block=b1", "thread=t1", "block=b1&thread=t1"])(
  "opens ordinary task cards in Details, preserving underlying %s and modal history",
  (target) => {
    const underlying = `?project=p1&${target}`;
    render(<View entry={`/agents/a1${underlying}`} />);
    fireEvent.click(screen.getByTestId("stream-task-card"));
    const opened = `${underlying}&task=tsk_012345abcdef&pane=details`;
    expect(screen.getByRole("status").textContent).toBe(opened);
    expect(screen.getByRole("status").getAttribute("data-modal")).toBe("true");
    // A card opened while a task is already selected replaces that modal entry.
    fireEvent.click(screen.getByTestId("stream-task-card"));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("status").textContent).toBe(underlying);
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    expect(screen.getByRole("status").textContent).toBe(opened);
  }
);
