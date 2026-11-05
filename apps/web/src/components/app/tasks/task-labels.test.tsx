// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TaskLabelPicker } from "./task-labels";
vi.mock("@/hooks/use-tasks", () => ({
  useTaskBoard: () => ({
    data: {
      labels: [
        { name: "Alpha", color: "red" },
        { name: "Beta", color: "blue" },
      ],
    },
  }),
}));
afterEach(cleanup);
it("blocks successive replacement actions while an open picker is saving", () => {
  const onChange = vi.fn();
  const props = {
    projectId: "project",
    value: [{ name: "Selected", color: "gray" }],
    onChange,
  };
  const { rerender } = render(<TaskLabelPicker {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit labels" }));
  fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
  expect(onChange).toHaveBeenCalledTimes(1);
  rerender(<TaskLabelPicker {...props} disabled />);
  fireEvent.click(screen.getByRole("button", { name: "Beta" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Remove label Selected" })
  );
  fireEvent.change(screen.getByLabelText("Label name"), {
    target: { value: "New" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create “New”" }));
  expect(onChange).toHaveBeenCalledTimes(1);
  rerender(
    <TaskLabelPicker
      {...props}
      value={[...props.value, { name: "Alpha", color: "red" }]}
    />
  );
  fireEvent.change(screen.getByLabelText("Label name"), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Beta" }));
  expect(onChange).toHaveBeenLastCalledWith([
    ...props.value,
    { name: "Alpha", color: "red" },
    { name: "Beta", color: "blue" },
  ]);
});
