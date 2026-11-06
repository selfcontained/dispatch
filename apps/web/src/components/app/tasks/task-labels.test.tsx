// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { TaskLabelPicker } from "./task-labels";
const visibilityMutation = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ hidden: true })
);
vi.mock("@/hooks/use-tasks", () => ({
  useTaskLabelVisibility: () => ({
    isPending: false,
    error: null,
    mutateAsync: visibilityMutation,
  }),
  useTaskBoard: () => ({
    data: {
      hiddenLabels: [{ name: "Retired", color: "gray" }],
      labels: [
        { name: "Alpha", color: "red" },
        { name: "Beta", color: "blue" },
      ],
    },
  }),
}));
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("blocks successive replacement actions while an open picker is saving", () => {
  const onChange = vi.fn();
  const props = {
    projectId: "project",
    value: [{ name: "Selected", color: "gray" }],
    onChange,
  };
  const { rerender } = render(<TaskLabelPicker {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit labels" }));
  fireEvent.click(screen.getByRole("option", { name: "Alpha" }));
  expect(onChange).toHaveBeenCalledTimes(1);
  rerender(<TaskLabelPicker {...props} disabled />);
  fireEvent.click(screen.getByRole("option", { name: "Beta" }));
  fireEvent.click(screen.getByRole("option", { name: "Selected" }));
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
  fireEvent.click(screen.getByRole("option", { name: "Beta" }));
  expect(onChange).toHaveBeenLastCalledWith([
    ...props.value,
    { name: "Alpha", color: "red" },
    { name: "Beta", color: "blue" },
  ]);
});

it("restores and adds a hidden search result without contradictory empty-state text", async () => {
  const onChange = vi.fn();
  render(
    <TaskLabelPicker projectId="project" value={[]} onChange={onChange} />
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit labels" }));
  fireEvent.change(screen.getByLabelText("Label name"), {
    target: { value: "Retired" },
  });
  expect(screen.queryByRole("button", { name: "Create “Retired”" })).toBeNull();
  expect(screen.queryByText("Type a name to create a label")).toBeNull();
  fireEvent.click(
    screen.getByRole("option", { name: "Restore and add Retired" })
  );
  expect(visibilityMutation).toHaveBeenCalledWith({
    name: "Retired",
    hidden: false,
  });
  await waitFor(() =>
    expect(onChange).toHaveBeenCalledWith([{ name: "Retired", color: "gray" }])
  );
  fireEvent.click(screen.getByRole("button", { name: "Manage labels" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Remove label Alpha from options" })
  );
  expect(visibilityMutation).toHaveBeenCalledWith({
    name: "Alpha",
    hidden: true,
  });
  expect(onChange).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Back to label picker" }));
  expect(screen.queryByRole("status")).toBeNull();
});

it("shows feedback and blocks creation until an overlong name is shortened", () => {
  const onChange = vi.fn();
  render(
    <TaskLabelPicker projectId="project" value={[]} onChange={onChange} />
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit labels" }));
  fireEvent.change(screen.getByLabelText("Label name"), {
    target: { value: "Test resource safeguards" },
  });
  expect(screen.getByRole("alert").textContent).toContain("16 characters");
  expect(
    screen
      .getByRole("button", { name: "Create “Test resource safeguards”" })
      .hasAttribute("disabled")
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("Label name"), {
    target: { value: "1234567890123456" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Create “1234567890123456”" })
  );
  expect(onChange).toHaveBeenCalledWith([
    expect.objectContaining({ name: "1234567890123456" }),
  ]);
});
