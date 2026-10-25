// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { TaskBoard } from "@/hooks/use-tasks";
import { TasksRoute } from "./tasks-route";

const projects = [
  { id: "p1", name: "First", repoRoot: "/first", color: "#000" },
  { id: "p2", name: "Second", repoRoot: "/second", color: "#000" },
  { id: "p3", name: "Third", repoRoot: "/third", color: "#000" },
  { id: "p4", name: "Fourth", repoRoot: "/fourth", color: "#000" },
  { id: "p5", name: "Fifth", repoRoot: "/fifth", color: "#000" },
];
const boardQuery = vi.hoisted(() =>
  vi.fn(() => ({
    data: undefined as TaskBoard | undefined,
    isLoading: true,
    error: null,
  }))
);
const viewport = vi.hoisted(() => ({ isMobile: false }));
vi.mock("@/hooks/use-projects", () => ({
  useProjectScope: () => {
    const location = useLocation();
    const id = new URLSearchParams(location.search).get("project");
    return {
      projectId: id || null,
      project: projects.find((project) => project.id === id),
      projects,
    };
  },
  useProjectSelection: () => {
    const location = useLocation();
    const id = new URLSearchParams(location.search).get("project");
    return { project: projects.find((project) => project.id === id), projects };
  },
}));
vi.mock("@/hooks/use-tasks", () => ({
  useTaskDetail: (id: string | null) => ({
    data: id ? { id, projectId: "p1" } : undefined,
  }),
  useTaskBoard: boardQuery,
  useTaskActions: () => ({
    createColumn: { mutateAsync: vi.fn() },
    restore: { mutate: vi.fn(), isPending: false },
  }),
}));
// Column automations are named by template; this route test has no
// QueryClient to fetch them with.
vi.mock("@/hooks/use-templates", () => ({
  useTemplates: () => ({ data: [] }),
}));
vi.mock("@/components/app/dashboard-context", () => ({
  useDashboardContext: () => ({
    agents: [],
    isMobile: viewport.isMobile,
    setMobileLeftOpen: vi.fn(),
  }),
}));
vi.mock("./section-shell", () => ({
  SectionShell: ({
    sidebar,
    children,
  }: {
    sidebar: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <div>
      {sidebar}
      {children}
    </div>
  ),
}));
vi.mock("@/components/app/project-location", () => ({
  ProjectIcon: () => <span aria-hidden="true" />,
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect: () => void;
  }) => <button onClick={onSelect}>{children}</button>,
  DropdownMenuSeparator: () => null,
}));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.hasPointerCapture = () => false;
});
afterEach(() => {
  cleanup();
  viewport.isMobile = false;
  boardQuery.mockReset();
  boardQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
});

it("resolves a task deep link, then clears it when the user changes projects", async () => {
  render(
    <MemoryRouter initialEntries={["/tasks?task=t1&project=p2"]}>
      <TasksRoute />
      <LocationProbe />
    </MemoryRouter>
  );
  await waitFor(() =>
    expect(screen.getByTestId("location").textContent).toContain("project=p1")
  );
  expect(screen.getByTestId("location").textContent).toContain("task=t1");
  // No saved views: the board is scoped by search and the assignee filter.
  expect(screen.queryByText("Views")).toBeNull();
  expect(screen.queryByText("Working now")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Second" }));
  await waitFor(() =>
    expect(screen.getByTestId("location").textContent).toContain("project=p2")
  );
  expect(screen.getByTestId("location").textContent).not.toContain("task=");
});

const pressed = (name: string) =>
  screen.getByRole("button", { name }).getAttribute("aria-pressed");

// Layout atoms are per project and read storage once, so each case below
// uses its own project.
it("shows a ?layout= link without saving it over the saved choice", () => {
  window.localStorage.setItem("dispatch:taskLayout:p3", JSON.stringify("list"));
  render(
    <MemoryRouter initialEntries={["/tasks?project=p3&layout=board"]}>
      <TasksRoute />
    </MemoryRouter>
  );
  expect(pressed("Board layout")).toBe("true");
  expect(window.localStorage.getItem("dispatch:taskLayout:p3")).toBe(
    JSON.stringify("list")
  );
});

it("keeps the saved layout on a phone", () => {
  viewport.isMobile = true;
  window.localStorage.setItem(
    "dispatch:taskLayout:p4",
    JSON.stringify("board")
  );
  render(
    <MemoryRouter initialEntries={["/tasks?project=p4"]}>
      <TasksRoute />
    </MemoryRouter>
  );
  expect(pressed("Board layout")).toBe("true");
});

it("defaults by width until a layout is picked, then saves the pick", () => {
  viewport.isMobile = true;
  const { unmount } = render(
    <MemoryRouter initialEntries={["/tasks?project=p5"]}>
      <TasksRoute />
    </MemoryRouter>
  );
  expect(pressed("List layout")).toBe("true");
  unmount();
  viewport.isMobile = false;
  render(
    <MemoryRouter initialEntries={["/tasks?project=p5"]}>
      <TasksRoute />
      <LocationProbe />
    </MemoryRouter>
  );
  expect(pressed("Board layout")).toBe("true");
  expect(window.localStorage.getItem("dispatch:taskLayout:p5")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "List layout" }));
  expect(window.localStorage.getItem("dispatch:taskLayout:p5")).toBe(
    JSON.stringify("list")
  );
  expect(screen.getByTestId("location").textContent).toContain("layout=list");
});

it("keeps Archived in the URL and selects the archived board query", async () => {
  render(
    <MemoryRouter initialEntries={["/tasks?project=p1&view=archived"]}>
      <TasksRoute />
      <LocationProbe />
    </MemoryRouter>
  );
  expect(pressed("Archived")).toBe("true");
  expect(boardQuery).toHaveBeenCalledWith("p1", true);
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  expect(screen.getByTestId("location").textContent).not.toContain(
    "view=archived"
  );
  expect(pressed("Archived")).toBe("false");
});

it("lists older archived tasks with column/time and filters them by search and assignee", async () => {
  const board = {
    projectId: "p1",
    columns: [
      {
        id: "done",
        key: "done",
        name: "Done",
        isDone: true,
        position: 0,
        trigger: null,
      },
    ],
    tasks: [
      {
        id: "old",
        title: "Old completed work",
        columnId: "done",
        completedAt: "2020-01-01T00:00:00Z",
        archivedAt: "2020-01-02T00:00:00Z",
        assignedAgentId: null,
      },
      {
        id: "other",
        title: "Other archived work",
        columnId: "done",
        completedAt: null,
        archivedAt: "2020-01-03T00:00:00Z",
        assignedAgentId: null,
      },
    ],
  } as TaskBoard;
  boardQuery.mockReturnValue({ data: board, isLoading: false, error: null });
  render(
    <MemoryRouter initialEntries={["/tasks?project=p1&view=archived"]}>
      <TasksRoute />
    </MemoryRouter>
  );
  expect(
    screen.getByRole("button", { name: "Old completed work" })
  ).toBeTruthy();
  expect(screen.getAllByText("Done").length).toBeGreaterThan(0);
  expect(
    document.querySelector('time[datetime="2020-01-02T00:00:00Z"]')
  ).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Search tasks" }), {
    target: { value: "Old completed" },
  });
  expect(
    screen.queryByRole("button", { name: "Other archived work" })
  ).toBeNull();
  fireEvent.click(screen.getByRole("combobox", { name: "Filter by assignee" }));
  fireEvent.click(
    await screen.findByRole("option", { name: /Needs attention/ })
  );
  expect(
    screen.queryByRole("button", { name: "Old completed work" })
  ).toBeNull();
});
