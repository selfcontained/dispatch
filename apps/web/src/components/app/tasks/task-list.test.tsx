// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Task, TaskColumn } from "@/hooks/use-tasks";
import { StatusSelect } from "./task-list";
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
