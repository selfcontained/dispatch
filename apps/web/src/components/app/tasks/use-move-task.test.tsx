// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApiError } from "@/lib/api";
import type { Task, TaskBoard } from "@/hooks/use-tasks";
import { useMoveTask } from "./use-move-task";

const update = vi.fn();
vi.mock("@/hooks/use-tasks", () => ({
  useTaskActions: () => ({ update: { mutateAsync: update } }),
}));
afterEach(() => {
  cleanup();
  update.mockReset();
});
const task = { id: "t1", columnId: "backlog", position: 0 } as Task;
function Harness() {
  const { moveTask, dialog } = useMoveTask("p1", {
    tasks: [task],
  } as TaskBoard);
  return (
    <>
      <button onClick={() => void moveTask(task, "ready")}>Move</button>
      {dialog}
    </>
  );
}
it("shows capacity refusal without offering an agent relaunch", async () => {
  update.mockRejectedValue(
    new ApiError(
      409,
      "Ready is full (1/1). Move a task out or increase its capacity.",
      "column_capacity_exceeded"
    )
  );
  render(<Harness />);
  fireEvent.click(screen.getByText("Move"));
  expect(
    await screen.findByRole("dialog", { name: "Could not move task" })
  ).toBeTruthy();
  expect(screen.getByText(/Ready is full/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Move and launch" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
});
it("only offers relaunch for agent_working and explains a capacity race on confirmation", async () => {
  update
    .mockRejectedValueOnce(new ApiError(409, "Agent working", "agent_working"))
    .mockRejectedValueOnce(
      new ApiError(409, "Ready is now full.", "column_capacity_exceeded")
    );
  render(<Harness />);
  fireEvent.click(screen.getByText("Move"));
  fireEvent.click(
    await screen.findByRole("button", { name: "Move and launch" })
  );
  expect(await screen.findByText("Ready is now full.")).toBeTruthy();
  expect(update).toHaveBeenLastCalledWith(
    expect.objectContaining({ confirmRelaunch: true })
  );
});
