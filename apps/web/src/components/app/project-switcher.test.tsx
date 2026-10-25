// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectSwitcher } from "./project-switcher";

const { projects } = vi.hoisted(() => ({
  projects: [
    { id: "pa", name: "Alpha", repoRoot: "/alpha", color: "#9575ed" },
    { id: "pb", name: "Beta", repoRoot: "/beta", color: "#38b7a0" },
  ],
}));
vi.mock("@/hooks/use-projects", async () => {
  const { useLocation } = await import("react-router-dom");
  return {
    useProjectSelection: () => {
      const id = new URLSearchParams(useLocation().search).get("project");
      return { project: projects.find((p) => p.id === id), projects };
    },
  };
});

afterEach(cleanup);

let goBack: () => void = () => {};
function Location() {
  const location = useLocation();
  const navigate = useNavigate();
  goBack = () => navigate(-1);
  return (
    <div data-testid="location">
      {location.pathname + location.search + location.hash}
    </div>
  );
}

function mount(path: string) {
  const client = new QueryClient();
  client.setQueryData(
    ["agents"],
    [
      { id: "a1", projectId: "pa" },
      { id: "b1", projectId: "pb" },
    ]
  );
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <ProjectSwitcher />
                <Location />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function choose(name: string) {
  const trigger = screen.getByRole("button", { name: "Filter by project" });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(screen.getByRole("menuitem", { name }));
}

const href = () => screen.getByTestId("location").textContent;

describe("project switcher", () => {
  it("deselects an open agent from another project in one navigation", () => {
    mount("/agents/a1/changes?project=pa&thread=t1&file=x.ts&line=3#top");
    choose("Beta");
    expect(href()).toBe("/agents?project=pb");
    // Back restores the original agent within its own project.
    act(() => goBack());
    expect(href()).toBe(
      "/agents/a1/changes?project=pa&thread=t1&file=x.ts&line=3#top"
    );
  });

  it("keeps the agent when the new scope still contains it", () => {
    mount("/agents/a1?project=pb");
    choose("Alpha");
    expect(href()).toBe("/agents/a1?project=pa");
    choose("All projects");
    expect(href()).toBe("/agents/a1?project=");
  });

  it("leaves non-agent routes in place", () => {
    mount("/automations?project=pa");
    choose("Beta");
    expect(href()).toBe("/automations?project=pb");
  });
});
