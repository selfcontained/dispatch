// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { TaskGoalProgress } from "./task-goal-progress";
import { TaskGoalList, goalChangeLines } from "./task-goal-list";

afterEach(cleanup);

it("renders equal segments with the count as text and hides at zero", () => {
  const view = render(<TaskGoalProgress counts={{ completed: 2, total: 3 }} />);
  const bar = screen.getByRole("progressbar");
  expect(bar.getAttribute("aria-valuetext")).toBe("2 of 3 goals complete");
  expect(bar.children).toHaveLength(3);
  expect(screen.getByText("2 of 3 goals complete")).toBeTruthy();
  view.rerender(<TaskGoalProgress counts={{ completed: 0, total: 0 }} />);
  expect(screen.queryByRole("progressbar")).toBeNull();
  view.rerender(<TaskGoalProgress counts={undefined} />);
  expect(screen.queryByRole("progressbar")).toBeNull();
});

it("lists goals in order with a status word, excluding retired from the bar", () => {
  render(
    <TaskGoalList
      goals={[
        { id: "a", title: "First", state: "completed", position: 0 },
        { id: "b", title: "Second", state: "open", position: 1 },
        { id: "c", title: "Gone", state: "retired", position: 2 },
      ]}
    />
  );
  expect(
    screen.getAllByRole("listitem").map((item) => item.textContent)
  ).toEqual(["FirstComplete", "SecondOpen", "GoneRetired"]);
  expect(screen.getByText("1 of 2 goals complete")).toBeTruthy();
});

it("describes goal activity", () => {
  expect(
    goalChangeLines({
      changes: [
        { goalId: "a", op: "added", title: "A" },
        { goalId: "a", op: "renamed", title: "B", fromTitle: "A" },
        { goalId: "a", op: "retired", title: "B", fromState: "open" },
      ],
    })
  ).toEqual(["Added “A”", "Renamed “A” to “B”", "Retired “B”"]);
  expect(goalChangeLines({})).toEqual([]);
});
