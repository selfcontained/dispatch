// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { taskKeys, type TaskDetail } from "@/hooks/use-tasks";
import { TaskDrawer } from "./task-drawer";

vi.mock("@/hooks/use-templates", () => ({
  useTemplates: () => ({ data: [] }),
}));
vi.mock("@/hooks/use-agent-model-catalog", () => ({
  useAgentModelCatalog: () => [],
}));

afterEach(cleanup);

it("keeps an unsaved description open when cached task fields change", async () => {
  const detail: TaskDetail = {
    id: "task-1",
    projectId: "project-1",
    columnId: "column-1",
    title: "Original title",
    body: "Original description",
    position: 0,
    assignedAgentId: null,
    links: [],
    createdBy: { kind: "user" },
    latestFailure: null,
    completedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    agents: [],
    events: [],
  };
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(taskKeys.detail(detail.id), detail);
  const props = {
    id: detail.id,
    projectId: detail.projectId,
    columns: [
      {
        id: "column-1",
        projectId: "project-1",
        key: "ready",
        name: "Ready",
        position: 0,
        isDone: false,
        trigger: null,
        createdAt: detail.createdAt,
        updatedAt: detail.updatedAt,
      },
    ],
    boardTasks: [detail],
    agents: [],
    close: vi.fn(),
    openTask: vi.fn(),
    moveTask: vi.fn(),
  };
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <TaskDrawer {...props} />
      </QueryClientProvider>
    </MemoryRouter>
  );
  fireEvent.click(screen.getByRole("button", { name: "Original description" }));
  const textarea = screen.getByRole("textbox");
  fireEvent.change(textarea, { target: { value: "My unsaved draft" } });

  act(() => {
    client.setQueryData(taskKeys.detail(detail.id), {
      ...detail,
      title: "Agent-renamed title",
      body: "New server body",
    });
  });

  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Agent-renamed title" })
    ).toBeTruthy()
  );
  expect(screen.getByRole("textbox")).toBe(textarea);
  expect((textarea as HTMLTextAreaElement).value).toBe("My unsaved draft");
});
