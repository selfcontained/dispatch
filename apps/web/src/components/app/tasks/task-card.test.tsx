// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeAll, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Task, TaskColumn } from "@/hooks/use-tasks";
import { TaskCard } from "./task-card";

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => {};
});
afterEach(cleanup);

const columns = ["Backlog", "Done"].map(
  (name, position) =>
    ({
      id: name,
      name,
      key: name,
      position,
      trigger: null,
    }) as unknown as TaskColumn
);
const task = (columnId: string) =>
  ({
    id: "tsk_1",
    projectId: "p1",
    title: "Ship it",
    columnId,
    links: [],
    createdBy: { kind: "user" },
    latestFailure: null,
    createdAt: new Date().toISOString(),
  }) as unknown as Task;

// A move lands the card in another column: a fresh mount, not an update.
function Board() {
  const [column, setColumn] = useState("Backlog");
  const card = (
    <TaskCard
      task={task(column)}
      columns={columns}
      agents={[]}
      onOpen={() => {}}
      onMove={setColumn}
    />
  );
  return column === "Backlog" ? (
    <div data-testid="backlog">{card}</div>
  ) : (
    <section data-testid="done">{card}</section>
  );
}

it("puts focus on the moved card's actions after a Move to… move", async () => {
  render(<Board />);
  fireEvent.keyDown(screen.getByRole("button", { name: "Ship it actions" }), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Move to…" }));
  fireEvent.click(await screen.findByRole("button", { name: "Done" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const actions = screen.getByRole("button", { name: "Ship it actions" });
  expect(screen.getByTestId("done").contains(actions)).toBe(true);
  expect(document.activeElement).toBe(actions);
});
