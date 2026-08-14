// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  type Location,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BrainProject } from "@/hooks/use-brain";
import { encodeRepoRoot } from "@/lib/brain-encoding";

import { BrainsListContent } from "./brains-pane";

// The sidebar owns the encode half of the Brain Explorer's URL contract: it
// turns a repo root into the base64url segment the detail pane decodes, and
// decides which row is selected by comparing that encoding against the param
// already in the URL. It is mounted on the real routes so the comparison runs
// against genuine params rather than a hand-built string.
vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);

const REPO = "/Users/brad/dev/apps/dispatch";
const OTHER = "/srv/other-repo";

function project(overrides: Partial<BrainProject> = {}): BrainProject {
  return {
    repoRoot: REPO,
    objectCount: 0,
    listCount: 0,
    eventCount: 0,
    ...overrides,
  };
}

function LocationProbe(): JSX.Element {
  const location: Location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}

function locationPath(): string {
  return screen.getByTestId("location").textContent ?? "";
}

function mountSidebar({
  path = "/automations/brains",
  projects = [] as BrainProject[] | null,
  onItemSelect,
}: {
  path?: string;
  /** null keeps the projects query pending, standing for "still loading". */
  projects?: BrainProject[] | null;
  onItemSelect?: () => void;
} = {}) {
  apiMock.mockImplementation(async (requestPath: string) => {
    if (requestPath === "/api/v1/brain/projects") {
      if (projects === null) return new Promise(() => {}) as never;
      return projects as never;
    }
    throw new Error(`unexpected request: ${requestPath}`);
  });

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  const element = <BrainsListContent onItemSelect={onItemSelect} />;
  render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/automations/brains" element={element} />
          <Route
            path="/automations/brains/:encodedRepoRoot"
            element={element}
          />
        </Routes>
        <LocationProbe />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function row(name: string): Promise<HTMLElement> {
  return screen.findByRole("button", { name: new RegExp(name) });
}

beforeEach(() => {
  apiMock.mockReset();
});

afterEach(cleanup);

describe("list states", () => {
  it("shows placeholders while the projects query is pending", async () => {
    mountSidebar({ projects: null });

    // Distinguishable from the empty state: neither the empty copy nor any row
    // may appear before the answer is known.
    await waitFor(() =>
      expect(
        document.querySelectorAll(".animate-pulse").length
      ).toBeGreaterThan(0)
    );
    expect(screen.queryByText("No brain data yet.")).toBeNull();
  });

  it("explains the empty state once the query resolves with nothing", async () => {
    mountSidebar({ projects: [] });

    expect(await screen.findByText("No brain data yet.")).toBeTruthy();
    expect(document.querySelectorAll(".animate-pulse")).toHaveLength(0);
  });

  it("shows the basename, the shortened path, and the full path on hover", async () => {
    mountSidebar({ projects: [project()] });

    await row("dispatch");
    // Exact text, not a substring of the row: the full repo root also ends in
    // "dispatch", so a row that skipped repoBasename would still contain it.
    expect(screen.getByText("dispatch", { selector: "div" })).toBeTruthy();
    // shortPath keeps only the last three segments; the untruncated root stays
    // reachable through the title attribute.
    expect(screen.getByText(".../dev/apps/dispatch")).toBeTruthy();
    expect(screen.getByTitle(REPO)).toBeTruthy();
  });
});

describe("entry counts", () => {
  it("renders a count per entry type that has entries", async () => {
    mountSidebar({
      projects: [project({ objectCount: 4, listCount: 9, eventCount: 2 })],
    });

    const item = await row("dispatch");
    expect(item.textContent).toContain("4");
    expect(item.textContent).toContain("9");
    expect(item.textContent).toContain("2");
  });

  it("omits an entry type with a zero count instead of showing a 0", async () => {
    // Each type is gated independently, so one fixture carrying a single
    // non-zero count leaves the other two guards free to fall away unnoticed —
    // their mutant renders the same row. Every type therefore gets a row where
    // it is the only non-zero count, and a row where it is zero.
    mountSidebar({
      projects: [
        project({ repoRoot: "/a/objects-only", objectCount: 7 }),
        project({ repoRoot: "/a/lists-only", listCount: 7 }),
        project({ repoRoot: "/a/events-only", eventCount: 7 }),
      ],
    });

    for (const name of ["objects-only", "lists-only", "events-only"]) {
      const item = await row(name);
      expect(item.textContent).toContain("7");
      expect(item.textContent).not.toContain("0");
    }
  });
});

describe("navigation", () => {
  it("routes a project row to its base64url-encoded repo root", async () => {
    mountSidebar({ projects: [project()] });

    fireEvent.click(await row("dispatch"));

    // This is the exact segment the detail pane decodes back into a repo root.
    await waitFor(() =>
      expect(locationPath()).toBe(`/automations/brains/${encodeRepoRoot(REPO)}`)
    );
  });

  it("returns to the overview from the Overview row", async () => {
    mountSidebar({
      path: `/automations/brains/${encodeRepoRoot(REPO)}`,
      projects: [project()],
    });

    fireEvent.click(await screen.findByRole("button", { name: /Overview/ }));

    await waitFor(() => expect(locationPath()).toBe("/automations/brains"));
  });

  it("closes the mobile sidebar after either kind of selection", async () => {
    const onItemSelect = vi.fn();
    mountSidebar({ projects: [project()], onItemSelect });

    fireEvent.click(await row("dispatch"));
    expect(onItemSelect).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Overview/ }));
    expect(onItemSelect).toHaveBeenCalledTimes(2);
  });
});

describe("keyboard activation", () => {
  it("opens a project with Enter", async () => {
    const onItemSelect = vi.fn();
    mountSidebar({ projects: [project()], onItemSelect });

    fireEvent.keyDown(await row("dispatch"), { key: "Enter" });

    await waitFor(() =>
      expect(locationPath()).toBe(`/automations/brains/${encodeRepoRoot(REPO)}`)
    );
    expect(onItemSelect).toHaveBeenCalledTimes(1);
  });

  it("opens a project with Space", async () => {
    // Kept separate from the Enter case rather than firing both at one
    // captured node: the first key navigates, and re-using a node captured
    // before that route change would only work by accident of reconciliation.
    const onItemSelect = vi.fn();
    mountSidebar({ projects: [project()], onItemSelect });

    fireEvent.keyDown(await row("dispatch"), { key: " " });

    await waitFor(() =>
      expect(locationPath()).toBe(`/automations/brains/${encodeRepoRoot(REPO)}`)
    );
    expect(onItemSelect).toHaveBeenCalledTimes(1);
  });

  it("swallows the Space keypress so the sidebar does not scroll", async () => {
    mountSidebar({ projects: [project()] });

    const item = await row("dispatch");
    const event = new KeyboardEvent("keydown", {
      key: " ",
      bubbles: true,
      cancelable: true,
    });
    item.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores keys that are not Enter or Space", async () => {
    const onItemSelect = vi.fn();
    mountSidebar({ projects: [project()], onItemSelect });

    fireEvent.keyDown(await row("dispatch"), { key: "a" });

    expect(onItemSelect).not.toHaveBeenCalled();
    expect(locationPath()).toBe("/automations/brains");
  });
});

describe("selection highlight", () => {
  it("marks only the project whose encoding matches the URL", async () => {
    mountSidebar({
      path: `/automations/brains/${encodeRepoRoot(REPO)}`,
      projects: [project(), project({ repoRoot: OTHER })],
    });

    expect((await row("dispatch")).className).toContain("border-r-primary");
    expect((await row("other-repo")).className).not.toContain(
      "border-r-primary"
    );
    // Overview has to give up its highlight too, or two rows read as current.
    expect(
      screen.getByRole("button", { name: /Overview/ }).className
    ).not.toContain("border-r-primary");
  });

  it("marks Overview instead when no project is in the URL", async () => {
    mountSidebar({ projects: [project()] });

    const overview = await screen.findByRole("button", { name: /Overview/ });
    expect(overview.className).toContain("border-r-primary");
    expect((await row("dispatch")).className).not.toContain("border-r-primary");
  });
});
