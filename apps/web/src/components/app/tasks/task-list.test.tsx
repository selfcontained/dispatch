// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Task, TaskColumn } from "@/hooks/use-tasks";
import { StatusSelect, TaskList } from "./task-list";
import type { TaskBoard } from "@/hooks/use-tasks";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
vi.mock("./task-trigger-dialog", () => ({
  ColumnTriggerStrip: () => null,
  TaskTriggerDialog: () => null,
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
  }) => (
    <div>
      <select
        aria-label="Status for task"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      >
        <option value="backlog">Backlog</option>
        <option value="ready">Ready</option>
      </select>
      {children}
    </div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));
afterEach(cleanup);
it("moves a task through the status selector used by the drawer", () => {
  const moveTask = vi.fn();
  const task = { id: "task", title: "Task", columnId: "backlog" } as Task;
  const columns = [
    { id: "backlog", name: "Backlog" },
    { id: "ready", name: "Ready" },
  ] as TaskColumn[];
  render(<StatusSelect task={task} columns={columns} moveTask={moveTask} />);
  fireEvent.change(screen.getByRole("combobox", { name: "Status for task" }), {
    target: { value: "ready" },
  });
  expect(moveTask).toHaveBeenCalledWith(task, "ready");
});

it("shows the launch instead of the agent and failure in a row", () => {
  const task = {
    id: "task",
    projectId: "p",
    title: "Task",
    columnId: "ready",
    position: 0,
    assignedAgentId: "agt_old",
    links: [],
    latestFailure: { reason: "old failure", at: new Date().toISOString() },
    launching: { templateId: "tpl_builder", at: new Date().toISOString() },
    createdAt: new Date().toISOString(),
  } as unknown as Task;
  const board = {
    projectId: "p",
    tasks: [task],
    columns: [
      {
        id: "ready",
        key: "ready",
        name: "Ready",
        position: 0,
        trigger: { templateId: "tpl_builder", templateName: "Builder" },
      },
    ],
  } as TaskBoard;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TaskList
        board={board}
        tasks={[task]}
        agents={[]}
        openTask={() => {}}
        moveTask={() => {}}
      />
    </QueryClientProvider>
  );
  expect(screen.getAllByText("Launching Builder…")).toHaveLength(2);
  expect(screen.queryByText(/launch failed/)).toBeNull();
  expect(screen.queryByTestId("task-agent-chip-agt_old")).toBeNull();
});

it("a search that hides a column's tasks does not make it deletable", async () => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => {};
  const task = { id: "task", projectId: "p", columnId: "backlog" } as Task;
  const board = {
    projectId: "p",
    tasks: [task],
    columns: [
      { id: "backlog", key: "backlog", name: "Backlog", position: 0 },
      { id: "ready", key: "ready", name: "Ready", position: 1 },
    ],
  } as TaskBoard;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TaskList
        board={board}
        tasks={[]}
        agents={[]}
        openTask={() => {}}
        moveTask={() => {}}
      />
    </QueryClientProvider>
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "Backlog menu" }), {
    key: "Enter",
  });
  const remove = await screen.findByRole("menuitem", {
    name: "Delete (empty it first)",
  });
  expect(remove.getAttribute("aria-disabled")).toBe("true");
});

it("keeps PR links distinct from the row's task navigation", () => {
  const openTask = vi.fn();
  const label = "PR #42: " + "long-label".repeat(20);
  const url = "https://github.com/example/repo/pull/42";
  const task = {
    id: "task",
    projectId: "p",
    title: "Linked task",
    columnId: "ready",
    position: 0,
    createdAt: new Date().toISOString(),
    links: [
      { kind: "pr", label, url },
      { kind: "url", label: "Docs", url: "https://example.com/docs" },
    ],
  } as Task;
  const board = {
    projectId: "p",
    tasks: [task],
    columns: [{ id: "ready", key: "ready", name: "Ready", position: 0 }],
  } as TaskBoard;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TaskList
        board={board}
        tasks={[task]}
        agents={[]}
        openTask={openTask}
        moveTask={() => {}}
      />
    </QueryClientProvider>
  );
  const link = screen.getByRole("link", { name: label });
  expect(link.getAttribute("href")).toBe(url);
  expect(link.getAttribute("target")).toBeNull();
  expect(link.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  expect(screen.queryByRole("link", { name: "Docs" })).toBeNull();
  // Prevent jsdom navigation while exercising the existing event propagation path.
  link.addEventListener("click", (event) => event.preventDefault());
  fireEvent.click(link);
  expect(openTask).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Linked task" }));
  expect(openTask).toHaveBeenCalledWith(task.id);
});
