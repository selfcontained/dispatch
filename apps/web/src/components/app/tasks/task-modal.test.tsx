// @vitest-environment jsdom
import { useEffect, useState } from "react";
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
const failing = vi.hoisted(() => ({
  task: null as Error | null,
  board: null as Error | null,
  refetch: vi.fn(),
}));
vi.mock("@/hooks/use-tasks", () => ({
  useAssignedTasks: () => ({ data: [task] }),
  useTaskDetail: (id: string | null) => ({
    data: id && !failing.task ? task : undefined,
    error: id ? failing.task : null,
    refetch: failing.refetch,
  }),
  useTaskBoard: (projectId: string | null) => ({
    data:
      projectId && !failing.board
        ? { projectId, columns: [], tasks: [{ ...task, position: 0 }] }
        : undefined,
    error: projectId ? failing.board : null,
    refetch: failing.refetch,
  }),
  useTaskActions: () => ({ update: { mutateAsync: vi.fn() } }),
}));
// The panel is the drawer's own; here only what the modal hands it matters.
vi.mock("./task-drawer", () => ({
  TaskDetailPanel: ({
    id,
    close,
    headerAction,
    openTask,
  }: {
    id: string;
    close: () => void;
    headerAction: React.ReactNode;
    openTask: (id: string) => void;
  }) => (
    <div data-testid="task-panel">
      {id}
      {headerAction}
      <button onClick={close}>Close task</button>
      <button onClick={() => openTask("tsk_2")}>Next task</button>
      <Preview />
    </div>
  ),
}));
// Stands in for FileLightbox: it closes on Escape from a window listener,
// after Radix's document-capture listener has already seen the key.
function Preview() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);
  return open ? (
    <div data-testid="file-lightbox" role="dialog" aria-label="File viewer" />
  ) : (
    <button onClick={() => setOpen(true)}>Preview</button>
  );
}
vi.mock("@/components/app/chat/chat-pane", () => ({ ChatPane: () => null }));

afterEach(() => {
  cleanup();
  failing.task = null;
  failing.board = null;
  failing.refetch.mockClear();
});

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
  expect(where()).toBe("/agents/a1?project=p1&task=tsk_1&pane=conversation");
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

it("keeps a way out when the task fails to load", () => {
  failing.task = new Error("Task not found");
  renderStream("/agents/a1?task=tsk_gone");
  expect(screen.getByRole("alert").textContent).toContain("Task not found");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(failing.refetch).toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole("button", { name: "Close task" })[0]);
  expect(where()).toBe("/agents/a1");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("shows the board's failure instead of loading forever, and closes", () => {
  failing.board = new Error("Board unavailable");
  renderStream("/agents/a1?task=tsk_1");
  expect(screen.getByRole("alert").textContent).toContain("Board unavailable");
  expect(screen.queryByText("Loading task…")).toBeNull();
  expect(
    screen.getByRole("link", { name: /Open in Tasks/ }).getAttribute("href")
  ).toBe("/tasks?task=tsk_1&project=p1");
  fireEvent.click(screen.getAllByRole("button", { name: "Close task" })[0]);
  expect(where()).toBe("/agents/a1");
});

it("closes an attachment preview on Escape, not the task", () => {
  renderStream("/agents/a1?task=tsk_1");
  const panel = screen.getByTestId("task-panel");
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  fireEvent.keyDown(screen.getByTestId("file-lightbox"), { key: "Escape" });
  expect(screen.queryByTestId("file-lightbox")).toBeNull();
  expect(where()).toBe("/agents/a1?task=tsk_1");
  expect(screen.getByTestId("task-panel")).toBe(panel);
  // With the preview gone, Escape closes the task again.
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(where()).toBe("/agents/a1");
});

it("selects Details when paging and preserves the modal closing history", () => {
  renderStream("/agents/a1");
  fireEvent.click(screen.getByRole("button", { name: /^Task:/ }));
  expect(where()).toContain("pane=conversation");
  fireEvent.click(screen.getByRole("button", { name: "Next task" }));
  expect(where()).toBe("/agents/a1?task=tsk_2&pane=details");
  fireEvent.click(screen.getByRole("button", { name: "Close task" }));
  expect(where()).toBe("/agents/a1");
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(where()).toBe("/agents/a1?from=before");
});

it.each(["block=b1", "thread=t1", "block=b1&thread=t1"])(
  "selects Details on modal paging while preserving underlying %s and closing history",
  (target) => {
    const underlying = `/agents/a1?project=p1&${target}`;
    renderStream(underlying);
    fireEvent.click(screen.getByRole("button", { name: /^Task:/ }));
    expect(where()).toBe(`${underlying}&task=tsk_1&pane=conversation`);
    fireEvent.click(screen.getByRole("button", { name: "Next task" }));
    expect(where()).toBe(`${underlying}&task=tsk_2&pane=details`);
    fireEvent.click(screen.getByRole("button", { name: "Close task" }));
    expect(where()).toBe(underlying);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(where()).toBe("/agents/a1?from=before");
  }
);

it("clears pane on deep-linked modal close while preserving underlying targets", () => {
  renderStream("/agents/a1?block=b1&thread=t1&task=tsk_1&pane=conversation");
  fireEvent.click(screen.getByRole("button", { name: "Next task" }));
  expect(where()).toBe("/agents/a1?block=b1&thread=t1&task=tsk_2&pane=details");
  fireEvent.click(screen.getByRole("button", { name: "Close task" }));
  expect(where()).toBe("/agents/a1?block=b1&thread=t1");
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(where()).toBe("/agents/a1?from=before");
});
