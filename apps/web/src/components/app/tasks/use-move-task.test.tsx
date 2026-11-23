// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ApiError } from "@/lib/api";
import type { Task, TaskBoard } from "@/hooks/use-tasks";
import { toast } from "@/components/ui/toast";
import { useMoveTask } from "./use-move-task";

vi.mock("@/components/ui/toast", () => ({ toast: { error: vi.fn() } }));

const update = vi.fn();
vi.mock("@/hooks/use-tasks", () => ({
  useTaskActions: () => ({ update: { mutateAsync: update } }),
}));
afterEach(() => {
  cleanup();
  update.mockReset();
});
const task = {
  id: "t1",
  columnId: "backlog",
  position: 0,
  launchTemplateId: "selected",
} as unknown as Task;
function Harness() {
  const { moveTask, dialog } = useMoveTask("p1", {
    tasks: [task],
    columns: [{ id: "ready", trigger: { templateId: "default" } }],
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
  await waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
  const [title, options] = vi.mocked(toast.error).mock.calls[0];
  expect(title).toContain("Couldn’t move");
  expect(String(options?.error)).toContain("Ready is full");
  expect(screen.queryByRole("button", { name: "Move and launch" })).toBeNull();
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

it("moves a task override directly without a preview or revision guard", async () => {
  update.mockResolvedValue(task);
  render(<Harness />);
  fireEvent.click(screen.getByText("Move"));
  expect(update).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledWith({
    id: "t1",
    columnId: "ready",
    beforeId: null,
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});
