// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { TaskLabelFilter } from "./task-label-filter";
afterEach(cleanup);
function Location() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">{location.search}</output>
      <button onClick={() => navigate(-1)}>Previous filter</button>
      <button onClick={() => navigate(1)}>Next filter</button>
    </>
  );
}
it("selects multiple URL labels, clears only labels and restores selection through navigation", () => {
  render(
    <MemoryRouter
      initialEntries={[
        "/tasks?project=p1&column=ready&layout=list&task=t1&pane=details&label=Bug",
      ]}
    >
      <TaskLabelFilter
        labels={[
          { name: "Bug", color: "red" },
          { name: "Release", color: "green" },
        ]}
      />
      <Location />
    </MemoryRouter>
  );
  fireEvent.click(screen.getByRole("button", { name: "Filter by labels" }));
  expect(
    screen.getByRole("checkbox", { name: "Bug" }).getAttribute("aria-checked")
  ).toBe("true");
  fireEvent.click(screen.getByRole("checkbox", { name: "Release" }));
  const selected = new URLSearchParams(
    screen.getByTestId("location").textContent!
  );
  expect(selected.getAll("label")).toEqual(["Bug", "Release"]);
  for (const [name, value] of [
    ["project", "p1"],
    ["column", "ready"],
    ["layout", "list"],
    ["task", "t1"],
    ["pane", "details"],
  ])
    expect(selected.get(name)).toBe(value);
  fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
  expect(
    new URLSearchParams(screen.getByTestId("location").textContent!).getAll(
      "label"
    )
  ).toEqual([]);
  expect(
    new URLSearchParams(screen.getByTestId("location").textContent!).get("task")
  ).toBe("t1");
  fireEvent.click(screen.getByRole("button", { name: "Previous filter" }));
  expect(
    screen.getByRole("checkbox", { name: "Bug" }).getAttribute("aria-checked")
  ).toBe("true");
  expect(
    screen
      .getByRole("checkbox", { name: "Release" })
      .getAttribute("aria-checked")
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Next filter" }));
  expect(
    screen
      .getByRole("checkbox", { name: "Release" })
      .getAttribute("aria-checked")
  ).toBe("false");
});
