// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { AssignedTaskChip } from "@/components/app/agent-pane";
import { TaskModal } from "./task-modal";

const task = { id: "tsk_1", projectId: "p1", title: "Build the board" };
vi.mock("@/hooks/use-tasks", () => ({
  useAssignedTasks: () => ({ data: [task] }),
  useTaskDetail: (id: string | null) => ({ data: id ? task : undefined }),
  useTaskBoard: (projectId: string | null) => ({
    data: projectId
      ? { projectId, columns: [], tasks: [{ ...task, position: 0 }] }
      : undefined,
  }),
  useTaskActions: () => ({ update: { mutateAsync: vi.fn() } }),
}));
// The panel is the drawer's own; here only what the modal hands it matters.
vi.mock("./task-drawer", () => ({
  TaskDetailPanel: ({
    id,
    close,
    headerAction,
  }: {
    id: string;
    close: () => void;
    headerAction: React.ReactNode;
  }) => (
    <div data-testid="task-panel">
      {id}
      {headerAction}
      <button onClick={close}>Close task</button>
    </div>
  ),
}));
vi.mock("@/components/app/chat/chat-pane", () => ({ ChatPane: () => null }));

afterEach(cleanup);

function Where() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="where">{location.pathname + location.search}</output>
      <button onClick={() => navigate(-1)}>Back</button>
    </>
  );
}
const renderStream = (entry: string) =>
  render(
    <MemoryRouter
      initialEntries={["/agents/a1?from=before", entry]}
      initialIndex={1}
    >
      <Routes>
        <Route
          path="/agents/:id"
          element={
            <>
              <div data-testid="stream">stream</div>
              <AssignedTaskChip agentId="a1" />
              <TaskModal agents={[]} isMobile={false} />
              <Where />
            </>
          }
        />
        <Route path="/tasks" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );
const where = () => screen.getByTestId("where").textContent;

it("opens the agent's task over the stream and closes back to it", () => {
  renderStream("/agents/a1?project=p1");
  const stream = screen.getByTestId("stream");
  fireEvent.click(
    screen.getByRole("button", { name: "Task: Build the board" })
  );
  expect(where()).toBe("/agents/a1?project=p1&task=tsk_1");
  expect(screen.getByRole("dialog").textContent).toContain("tsk_1");
  // The stream stays mounted under the modal: its scroll is untouched.
  expect(screen.getByTestId("stream")).toBe(stream);
  expect(
    screen.getByRole("link", { name: /Open in Tasks/ }).getAttribute("href")
  ).toBe("/tasks?task=tsk_1&project=p1");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(where()).toBe("/agents/a1?project=p1");
  expect(screen.getByTestId("stream")).toBe(stream);
});

it("pops the entry opening pushed, so Back doesn't reopen it", () => {
  renderStream("/agents/a1");
  fireEvent.click(screen.getByRole("button", { name: /^Task:/ }));
  fireEvent.click(screen.getByRole("button", { name: "Close task" }));
  expect(where()).toBe("/agents/a1");
  expect(screen.queryByRole("dialog")).toBeNull();
  // Back leaves the stream rather than landing on the closed modal's entry.
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(where()).toBe("/agents/a1?from=before");
});

it("opens from a deep link and closes in place", () => {
  renderStream("/agents/a1?task=tsk_1");
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close task" }));
  expect(where()).toBe("/agents/a1");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("links through to the task on the Tasks surface", () => {
  renderStream("/agents/a1?task=tsk_1");
  fireEvent.click(screen.getByRole("link", { name: /Open in Tasks/ }));
  expect(where()).toBe("/tasks?task=tsk_1&project=p1");
});
