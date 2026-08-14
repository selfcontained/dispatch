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
  useNavigationType,
  type Location,
  type NavigationType,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BrainCollectionSummary } from "@/hooks/use-brain";
import { encodeRepoRoot } from "@/lib/brain-encoding";

import { BrainsDetailPane } from "./brains-detail-pane";

// The pane is mounted on the same three routes the real router declares, so
// useParams supplies the params exactly as production does. What is under test
// is everything the pane owns between the URL and its children: decoding the
// base64url repo root (and recovering when it is malformed), decoding and
// re-encoding collection names through the path segment, and the destructive
// "Clear project" flow. The real use-brain queries and mutations run; only the
// HTTP seam, the toaster, and the already-covered collection view are stubbed.
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
// Toaster is stubbed alongside toast so that a component pulled into the tree
// later fails on its own terms rather than as "Element type is invalid".
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

// BrainCollectionView has its own 590-line suite. Here it stands in as a probe
// for the three props the pane is responsible for wiring, plus the cleared
// callback — a real mount would fire its own queries and drown those out.
vi.mock("@/components/app/brains-collection-view", () => ({
  BrainCollectionView: ({
    repoRoot,
    collection,
    search,
    onCollectionCleared,
  }: {
    repoRoot: string;
    collection: string | null;
    search: string;
    onCollectionCleared: () => void;
  }) => (
    <div>
      <span data-testid="view-repo-root">{repoRoot}</span>
      <span data-testid="view-collection">{collection ?? "<null>"}</span>
      <span data-testid="view-search">{search}</span>
      <button type="button" onClick={onCollectionCleared}>
        simulate cleared
      </button>
    </div>
  ),
}));

const { api } = await import("@/lib/api");
const { toast } = await import("sonner");
const apiMock = vi.mocked(api);
const toastSuccess = vi.mocked(toast.success);
const toastError = vi.mocked(toast.error);

const REPO = "/Users/brad/dev/apps/dispatch";
const ENCODED = encodeRepoRoot(REPO);

function summary(
  collection: string,
  objectCount = 0,
  listCount = 0,
  eventCount = 0
): BrainCollectionSummary {
  return { collection, objectCount, listCount, eventCount };
}

function LocationProbe(): JSX.Element {
  const location: Location = useLocation();
  const navigationType: NavigationType = useNavigationType();
  return (
    <>
      <span data-testid="location">{location.pathname}</span>
      <span data-testid="navigation-type">{navigationType}</span>
    </>
  );
}

function locationPath(): string {
  return screen.getByTestId("location").textContent ?? "";
}

/** "PUSH" leaves the previous entry in history; "REPLACE" discards it. */
function navigationType(): string {
  return screen.getByTestId("navigation-type").textContent ?? "";
}

function mountPane({
  path = `/automations/brains/${ENCODED}`,
  collections = [] as BrainCollectionSummary[] | null,
  onDeleteProject,
}: {
  path?: string;
  /** null keeps the collections query pending, standing for "still loading". */
  collections?: BrainCollectionSummary[] | null;
  onDeleteProject?: () => Promise<unknown>;
} = {}) {
  apiMock.mockImplementation(
    async (requestPath: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        if (!onDeleteProject)
          return { objects: 0, lists: 0, events: 0 } as never;
        return (await onDeleteProject()) as never;
      }
      if (requestPath.split("?")[0] === "/api/v1/brain/collections") {
        if (collections === null) return new Promise(() => {}) as never;
        return collections as never;
      }
      throw new Error(`unexpected request: ${requestPath}`);
    }
  );

  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/automations/brains" element={<BrainsDetailPane />} />
          <Route
            path="/automations/brains/:encodedRepoRoot"
            element={<BrainsDetailPane />}
          />
          <Route
            path="/automations/brains/:encodedRepoRoot/:collection"
            element={<BrainsDetailPane />}
          />
        </Routes>
        <LocationProbe />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function deleteCalls(): string[] {
  return apiMock.mock.calls
    .filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "DELETE"
    )
    .map(([path]) => path as string);
}

function pillName(name: string): RegExp {
  // A pill's accessible name is the label immediately followed by its count
  // badge with no separator ("config10"), so the count is matched explicitly
  // rather than left to a word boundary that never lands between two word
  // characters. Fully anchored so one label cannot match a longer one.
  return new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d*$`);
}

/** Pills for real collections only appear once the collections query lands. */
function findPill(name: string): Promise<HTMLElement> {
  return screen.findByRole("button", { name: pillName(name) });
}

function pill(name: string): HTMLElement {
  return screen.getByRole("button", { name: pillName(name) });
}

function openProjectDelete() {
  fireEvent.click(screen.getByRole("button", { name: /Clear project/ }));
}

function confirmButton(): HTMLElement {
  return screen.getByRole("button", { name: /Delete permanently|Deleting/ });
}

beforeEach(() => {
  apiMock.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

afterEach(cleanup);

describe("repo root routing", () => {
  it("shows the explorer placeholder when no project is in the URL", () => {
    mountPane({ path: "/automations/brains" });

    expect(screen.getByText("Brain Explorer")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Clear project/ })).toBeNull();
  });

  it("decodes the base64url repo root into the project header", () => {
    mountPane();

    // Both the basename and the full path come out of the decode — a decoder
    // that dropped the base64url substitutions would render mojibake here.
    expect(screen.getByRole("heading", { name: "dispatch" })).toBeTruthy();
    expect(screen.getByTitle(REPO).textContent).toBe(REPO);
    expect(screen.getByTestId("view-repo-root").textContent).toBe(REPO);
  });

  it("replaces a malformed repo root in the URL with the overview route", async () => {
    // "!!!" is not valid base64, so decodeRepoRoot throws. Recovering by
    // rendering the overview is not enough — the undecodable root has to leave
    // the address bar too, or a reload or a shared link lands right back on it.
    mountPane({ path: "/automations/brains/!!!" });

    await waitFor(() => expect(locationPath()).toBe("/automations/brains"));
    expect(await screen.findByText("Brain Explorer")).toBeTruthy();
    // Replaced, not pushed: a pushed redirect leaves the undecodable root one
    // Back press away, and going Back immediately redirects forward again —
    // the user is trapped on the button.
    expect(navigationType()).toBe("REPLACE");
  });

  it("hands the view the real collection name from an escaped path segment", () => {
    // Collection names may contain slashes, which only survive the path as
    // %2F — the view must receive the real name, not the escaped one.
    mountPane({
      path: `/automations/brains/${ENCODED}/${encodeURIComponent("ops/deploy")}`,
      collections: [summary("ops/deploy", 1, 0, 0)],
    });

    expect(screen.getByTestId("view-collection").textContent).toBe(
      "ops/deploy"
    );
  });

  it("leaves a percent sign in the collection name alone", () => {
    // react-router already decodes path params. Decoding a second time throws
    // URIError on "50%off" — a collection an agent can create and the sidebar
    // will happily link to — taking the whole pane down with it.
    mountPane({
      path: `/automations/brains/${ENCODED}/${encodeURIComponent("50%off")}`,
      collections: [summary("50%off", 1, 0, 0)],
    });

    expect(screen.getByTestId("view-collection").textContent).toBe("50%off");
  });

  it("does not treat an escape sequence in a collection name as an escape", () => {
    // "%41" is a legal collection name, not an encoded "A". A second decode
    // would select a collection that does not exist and render it empty.
    mountPane({
      path: `/automations/brains/${ENCODED}/${encodeURIComponent("%41")}`,
      collections: [summary("%41", 1, 0, 0)],
    });

    expect(screen.getByTestId("view-collection").textContent).toBe("%41");
  });
});

describe("collection pills", () => {
  it("renders one pill per collection with its summed entry count", async () => {
    mountPane({
      collections: [summary("config", 2, 3, 5), summary("notes", 1, 0, 0)],
    });

    // The badge is the total across all three entry types, not just objects,
    // and is matched whole so a stray digit cannot stand in for the sum.
    expect((await findPill("config")).textContent).toBe("config10");
    expect(pill("notes").textContent).toBe("notes1");
  });

  it("marks All active while no collection is selected", async () => {
    mountPane({ collections: [summary("config", 1, 0, 0)] });

    const config = await findPill("config");
    expect(pill("All").className).toContain("bg-primary/15");
    expect(config.className).not.toContain("bg-primary/15");
  });

  it("moves the active marker to the collection named in the URL", async () => {
    mountPane({
      path: `/automations/brains/${ENCODED}/config`,
      collections: [summary("config", 1, 0, 0)],
    });

    const config = await findPill("config");
    expect(config.className).toContain("bg-primary/15");
    expect(pill("All").className).not.toContain("bg-primary/15");
  });

  it("re-encodes the collection name when navigating to its pill", async () => {
    mountPane({ collections: [summary("ops/deploy", 1, 0, 0)] });

    fireEvent.click(await findPill("ops/deploy"));

    // A raw slash here would push a route the router does not declare.
    await waitFor(() =>
      expect(locationPath()).toBe(`/automations/brains/${ENCODED}/ops%2Fdeploy`)
    );
  });

  it("returns to the project root from the All pill", async () => {
    mountPane({
      path: `/automations/brains/${ENCODED}/config`,
      collections: [summary("config", 1, 0, 0)],
    });
    await findPill("config");

    fireEvent.click(pill("All"));

    await waitFor(() =>
      expect(locationPath()).toBe(`/automations/brains/${ENCODED}`)
    );
    // Choosing a different collection is ordinary navigation, so it stays on
    // the history stack — unlike the redirects, which replace.
    expect(navigationType()).toBe("PUSH");
  });

  it("replaces history when the view reports its collection cleared", async () => {
    mountPane({
      path: `/automations/brains/${ENCODED}/config`,
      collections: [summary("config", 1, 0, 0)],
    });

    fireEvent.click(screen.getByRole("button", { name: "simulate cleared" }));

    await waitFor(() =>
      expect(locationPath()).toBe(`/automations/brains/${ENCODED}`)
    );
    // The collection no longer exists, so its URL must not stay reachable
    // through the Back button.
    expect(navigationType()).toBe("REPLACE");
  });
});

describe("search filter", () => {
  it("passes the typed filter down to the collection view", () => {
    mountPane();

    fireEvent.change(screen.getByPlaceholderText("Filter..."), {
      target: { value: "queue" },
    });

    expect(screen.getByTestId("view-search").textContent).toBe("queue");
  });
});

describe("clear project", () => {
  it("keeps the confirmation closed until the action is pressed", () => {
    mountPane();

    expect(screen.queryByText("Clear this project?")).toBeNull();

    openProjectDelete();

    expect(screen.getByText("Clear this project?")).toBeTruthy();
  });

  it("deletes nothing when the confirmation is cancelled", async () => {
    mountPane();

    openProjectDelete();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByText("Clear this project?")).toBeNull()
    );
    expect(deleteCalls()).toHaveLength(0);
  });

  it("scopes the delete to this project and reports the total removed", async () => {
    mountPane({
      onDeleteProject: async () => ({ objects: 4, lists: 2, events: 7 }),
    });

    openProjectDelete();
    fireEvent.click(confirmButton());

    await waitFor(() => expect(deleteCalls()).toHaveLength(1));
    // repoRoot must be query-encoded; an unencoded path would truncate at the
    // first slash and clear the wrong project.
    expect(deleteCalls()[0]).toBe(
      `/api/v1/brain/projects?repoRoot=${encodeURIComponent(REPO)}`
    );
    // The toast quotes the sum of all three entry types, not one of them.
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "Deleted 13 entries from this project."
      )
    );
  });

  it("leaves the deleted project for the overview without keeping it in history", async () => {
    // Only the navigation is asserted here. The dialog does close, but this
    // test cannot be the thing that proves it: leaving the project unmounts
    // the dialog either way, so a missing setProjectDeleteOpen(false) is
    // invisible from the outside.
    mountPane({
      onDeleteProject: async () => ({ objects: 1, lists: 0, events: 0 }),
    });

    openProjectDelete();
    fireEvent.click(confirmButton());

    await waitFor(() => expect(locationPath()).toBe("/automations/brains"));
    // Back must not return to a project whose data is gone.
    expect(navigationType()).toBe("REPLACE");
  });

  it("keeps the dialog open on the project view when the delete fails", async () => {
    mountPane({
      onDeleteProject: async () => {
        throw new Error("boom");
      },
    });

    openProjectDelete();
    fireEvent.click(confirmButton());

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Could not delete project brain data."
      )
    );
    // Navigating away on a failed delete would hide a project that still has
    // all of its data.
    expect(locationPath()).toBe(`/automations/brains/${ENCODED}`);
    expect(screen.getByText("Clear this project?")).toBeTruthy();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("disables both dialog buttons while the delete is in flight", async () => {
    let release: (value: unknown) => void = () => {};
    mountPane({
      onDeleteProject: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });

    openProjectDelete();
    fireEvent.click(confirmButton());

    // A second confirm click during the request would fire a second DELETE.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Deleting..." })).toBeTruthy()
    );
    expect(
      (screen.getByRole("button", { name: "Deleting..." }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);

    release({ objects: 1, lists: 0, events: 0 });
    await waitFor(() => expect(locationPath()).toBe("/automations/brains"));
    expect(deleteCalls()).toHaveLength(1);
  });
});
