// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

import type { Task, TaskColumn } from "@/hooks/use-tasks";
import { AssigneeSelect } from "./task-assignee-select";
import { TaskCardOverlay } from "./task-card";
import { TaskList } from "./task-list";

vi.mock("@/hooks/use-projects", () => ({
  useProjectScope: () => ({ projectId: "p1" }),
}));
vi.mock("./task-column-menu", () => ({ TaskColumnMenu: () => null }));
vi.mock("./task-trigger-dialog", () => ({ ColumnTriggerStrip: () => null }));
vi.mock("@/lib/api", () => ({ api: vi.fn().mockResolvedValue({}) }));

afterEach(cleanup);

const column = {
  id: "c1",
  key: "in_progress",
  name: "In progress",
  position: 0,
  capacity: null,
  activeTaskCount: 1,
} as unknown as TaskColumn;

function views(assignedAgentId: string | null) {
  const task = {
    id: "t1",
    title: "Ship it",
    projectId: "p1",
    columnId: "c1",
    position: 0,
    assignedAgentId,
    createdBy: { kind: "user" },
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
    links: [],
    labels: [],
  } as unknown as Task;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  // An archived agent: gone from the live list, kept by the identity endpoint.
  client.setQueryData(["agents"], []);
  client.setQueryData(["agent-identity", "agt_gone"], {
    id: "agt_gone",
    name: "Retired builder",
    type: "claude",
    archived: true,
    projectId: "p1",
    seat: null,
    rootId: null,
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <div data-testid="card">
          <TaskCardOverlay task={task} columns={[column]} agents={[]} />
        </div>
        <div data-testid="list">
          <TaskList
            board={{ projectId: "p1", columns: [column], tasks: [task] }}
            tasks={[task]}
            agents={[]}
            openTask={() => {}}
            moveTask={() => {}}
          />
        </div>
        <div data-testid="drawer">
          <AssigneeSelect
            value={assignedAgentId}
            agents={[]}
            projectId="p1"
            onChange={() => {}}
          />
        </div>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

it("names an archived assignee the same way in the card, list and drawer", () => {
  views("agt_gone");
  for (const view of ["card", "list", "drawer"]) {
    const element = screen.getByTestId(view);
    expect(element.textContent, view).toContain("Retired builder");
    expect(element.textContent, view).not.toContain("Unassigned");
    expect(
      element.querySelector('[data-testid="task-agent-chip-agt_gone"]'),
      view
    ).toBeTruthy();
  }
});

it("says Unassigned only when nobody is assigned", () => {
  views(null);
  for (const view of ["list", "drawer"])
    expect(screen.getByTestId(view).textContent).toContain("Unassigned");
});
