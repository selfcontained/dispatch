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
import {
  MemoryRouter,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { taskKeys, type TaskDetail } from "@/hooks/use-tasks";
import type { Agent } from "@/components/app/types";
import { TaskDrawer } from "./task-drawer";
import { assigneeOptions } from "./task-utils";

// The "New agent…" launch dialog reads the enabled engines from the dashboard.
vi.mock("@/components/app/dashboard-context", () => ({
  useDashboardContext: () => ({
    enabledAgentTypes: ["claude"],
    agents: [],
    isMobile: false,
    setMobileLeftOpen: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-templates", () => ({
  useTemplates: () => ({ data: [] }),
}));
vi.mock("@/hooks/use-agent-model-catalog", () => ({
  useAgentModelCatalog: () => [],
}));

vi.mock("./task-conversation", () => ({
  TaskConversation: ({
    taskId,
    active,
  }: {
    taskId: string;
    active: boolean;
  }) => (
    <div data-testid="task-conversation" data-active={active}>
      {taskId}
    </div>
  ),
}));

const summary = vi.hoisted(() => ({ unread: 0 as number | undefined }));
vi.mock("@/hooks/use-chat-unread-summary", () => ({
  useTaskChatUnread: () => summary.unread,
}));
afterEach(() => {
  cleanup();
  summary.unread = 0;
});

it("offers the project's agents for assignment, running first", () => {
  const agent = (id: string, status: string, projectId = "p1") =>
    ({ id, name: id, status, projectId }) as unknown as Agent;
  const agents = [
    agent("b-stopped", "stopped"),
    agent("other-project", "running", "p2"),
    agent("c-running", "running"),
    agent("a-stopped", "stopped"),
    agent("current-elsewhere", "stopped", "p2"),
  ];
  expect(
    assigneeOptions(agents, "p1", "current-elsewhere").map((item) => item.id)
  ).toEqual(["c-running", "a-stopped", "b-stopped", "current-elsewhere"]);
});

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
  launching: null,
  completedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  agents: [],
  events: [],
  attachments: [],
};

it("keeps an unsaved description open when cached task fields change", async () => {
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
    isMobile: false,
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
  expect(
    screen.getByTestId("task-conversation").getAttribute("data-active")
  ).toBe("false");
  expect((textarea as HTMLTextAreaElement).value).toBe("My unsaved draft");
});

function Where() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="where">
        {location.search}|{JSON.stringify(location.state)}
      </output>
      <button onClick={() => navigate("?task=task-2")}>Other task</button>
      <button onClick={() => navigate(-1)}>Back</button>
    </>
  );
}
function RoutedDrawer() {
  const [params] = useSearchParams();
  return (
    <TaskDrawer
      id={params.get("task") ?? detail.id}
      projectId={detail.projectId}
      columns={[]}
      boardTasks={[detail]}
      agents={[]}
      close={vi.fn()}
      openTask={vi.fn()}
      moveTask={vi.fn()}
      isMobile={false}
    />
  );
}
function renderTask(search = "?task=task-1") {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(taskKeys.detail(detail.id), detail);
  client.setQueryData(taskKeys.detail("task-2"), { ...detail, id: "task-2" });
  return {
    client,
    ...render(
      <MemoryRouter
        initialEntries={[
          "/before",
          { pathname: "/tasks", search, state: { taskModal: true } },
        ]}
        initialIndex={1}
      >
        <QueryClientProvider client={client}>
          <RoutedDrawer />
          <Where />
        </QueryClientProvider>
      </MemoryRouter>
    ),
  };
}
const selectTab = (name: string) =>
  fireEvent.mouseDown(screen.getByRole("tab", { name }), {
    button: 0,
    ctrlKey: false,
  });

it.each([
  ["?task=task-1", 0, "Details"],
  ["?task=task-1&block=b1", 0, "Conversation"],
  ["?task=task-1&thread=b1", 0, "Conversation"],
  ["?task=task-1", 3, "Conversation"],
  ["?task=task-1&pane=conversation", 0, "Conversation"],
  ["?task=task-1&pane=details", 3, "Details"],
])("resolves %s with %i unread to %s", (search, unread, tab) => {
  summary.unread = unread;
  renderTask(search);
  expect(
    screen
      .getByRole("tab", { name: new RegExp(`^${tab}`) })
      .getAttribute("data-state")
  ).toBe("active");
  expect(
    screen.getByTestId("task-conversation").getAttribute("data-active")
  ).toBe(String(tab === "Conversation"));
});

it("writes pane with replace and retains the modal opening state", () => {
  renderTask("?task=task-1&project=p1");
  selectTab("Conversation");
  expect(screen.getByTestId("where").textContent).toBe(
    '?task=task-1&project=p1&pane=conversation|{"taskModal":true}'
  );
  expect(screen.getByTestId("task-conversation")).toBeTruthy();
  selectTab("Details");
  expect(
    screen.getByTestId("task-conversation").getAttribute("data-active")
  ).toBe("false");
  expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByTestId("where").textContent).toBe("|null");
});

it("keeps Conversation selected when mark-read clears the badge", () => {
  summary.unread = 3;
  const { client } = renderTask();
  expect(screen.getByLabelText("3 unread posts")).toBeTruthy();
  summary.unread = 0;
  act(() =>
    client.setQueryData(taskKeys.detail(detail.id), {
      ...detail,
      title: "Updated",
    })
  );
  return waitFor(() => {
    expect(screen.queryByLabelText("3 unread posts")).toBeNull();
    expect(
      screen
        .getByRole("tab", { name: "Conversation" })
        .getAttribute("data-state")
    ).toBe("active");
  });
});

it("lets late unread data choose Conversation until the user chooses Details", async () => {
  summary.unread = undefined;
  const { client } = renderTask();
  expect(
    screen.getByRole("tab", { name: "Details" }).getAttribute("data-state")
  ).toBe("active");
  summary.unread = 2;
  act(() =>
    client.setQueryData(taskKeys.detail(detail.id), {
      ...detail,
      title: "Updated",
    })
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("tab", { name: /^Conversation/ })
        .getAttribute("data-state")
    ).toBe("active")
  );
  selectTab("Details");
  summary.unread = 4;
  act(() =>
    client.setQueryData(taskKeys.detail(detail.id), {
      ...detail,
      title: "Updated again",
    })
  );
  await waitFor(() =>
    expect(
      screen.getByRole("tab", { name: "Details" }).getAttribute("data-state")
    ).toBe("active")
  );
});

it("resolves a fresh default for another task after a reader chose Details", () => {
  summary.unread = 3;
  renderTask();
  selectTab("Details");
  fireEvent.click(screen.getByRole("button", { name: "Other task" }));
  expect(
    screen
      .getByRole("tab", { name: /^Conversation/ })
      .getAttribute("data-state")
  ).toBe("active");
  expect(screen.getByTestId("task-conversation").textContent).toBe("task-2");
});

it("keeps Details when the reader interacts before the unread query arrives", async () => {
  summary.unread = undefined;
  const { client } = renderTask();
  fireEvent.pointerDown(screen.getByRole("tab", { name: "Details" }));
  summary.unread = 2;
  act(() =>
    client.setQueryData(taskKeys.detail(detail.id), {
      ...detail,
      title: "Late summary",
    })
  );
  await waitFor(() =>
    expect(
      screen.getByRole("tab", { name: "Details" }).getAttribute("data-state")
    ).toBe("active")
  );
});
