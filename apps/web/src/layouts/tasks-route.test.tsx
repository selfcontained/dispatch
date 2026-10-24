// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { TasksRoute } from "./tasks-route";

const projects = [
  { id: "p1", name: "First", repoRoot: "/first", color: "#000" },
  { id: "p2", name: "Second", repoRoot: "/second", color: "#000" },
];
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
  useTaskBoard: () => ({ data: undefined, isLoading: true, error: null }),
  useTaskActions: () => ({ createColumn: { mutateAsync: vi.fn() } }),
}));
vi.mock("@/components/app/dashboard-context", () => ({
  useDashboardContext: () => ({ agents: [], isMobile: false }),
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

afterEach(cleanup);

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

  fireEvent.click(screen.getByRole("button", { name: "Second" }));
  await waitFor(() =>
    expect(screen.getByTestId("location").textContent).toContain("project=p2")
  );
  expect(screen.getByTestId("location").textContent).not.toContain("task=");
});
