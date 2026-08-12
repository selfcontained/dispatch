// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BrainCollectionSummary,
  BrainEvent,
  BrainList,
  BrainObject,
  BrainProject,
} from "@/hooks/use-brain";

import { BrainCollectionView } from "./brains-collection-view";

// The view renders its real card tree and the real use-brain queries and
// mutations; only the HTTP seam and the toaster are mocked. What is under test
// is the bulk-delete contract added in #929 — which URL each "Delete all"
// sends, what count the confirmation is allowed to quote, and when clearing an
// entry type is allowed to navigate away from the collection. Every one of
// those is decided from unfiltered scope totals rather than the rendered rows,
// so a stubbed card tree could not tell the two apart.
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { api } = await import("@/lib/api");
const { toast } = await import("sonner");
const apiMock = vi.mocked(api);
const toastSuccess = vi.mocked(toast.success);
const toastError = vi.mocked(toast.error);

const REPO = "/repo";

function makeObject(overrides: Partial<BrainObject> = {}): BrainObject {
  return {
    collection: "config",
    name: "app-settings",
    value: { theme: "dark" },
    revision: 3,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-02T10:00:00.000Z",
    createdByAgentId: "agt_1",
    updatedByAgentId: "agt_1",
    ...overrides,
  };
}

function makeList(overrides: Partial<BrainList> = {}): BrainList {
  return {
    collection: "config",
    name: "task-queue",
    revision: 2,
    itemCount: 0,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-02T10:00:00.000Z",
    createdByAgentId: "agt_1",
    updatedByAgentId: "agt_1",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<BrainEvent> = {}): BrainEvent {
  return {
    id: "evt_1",
    collection: "config",
    kind: "build",
    subject: null,
    tags: [],
    value: { ok: true },
    createdAt: "2026-08-02T10:00:00.000Z",
    agentId: "agt_1",
    ...overrides,
  };
}

type Totals = Pick<
  BrainCollectionSummary,
  "objectCount" | "listCount" | "eventCount"
>;

function totals(
  objectCount: number,
  listCount: number,
  eventCount: number
): Totals {
  return { objectCount, listCount, eventCount };
}

function routeOf(path: string): string {
  return path.split("?")[0];
}

function defaultDeleteResponse(path: string): unknown {
  const route = routeOf(path);
  if (route.startsWith("/api/v1/brain/collections/"))
    return { objects: 1, lists: 1, events: 1 };
  if (
    route === "/api/v1/brain/objects" ||
    route === "/api/v1/brain/lists" ||
    route === "/api/v1/brain/events"
  )
    return { deleted: 1 };
  return { deleted: true };
}

function mountView({
  collection = "config" as string | null,
  search = "",
  objects = [] as BrainObject[],
  lists = [] as BrainList[],
  events = [] as BrainEvent[],
  scopeTotals,
  onDelete = defaultDeleteResponse,
}: {
  collection?: string | null;
  search?: string;
  objects?: BrainObject[];
  lists?: BrainList[];
  events?: BrainEvent[];
  /**
   * Unfiltered totals for the active scope. Defaults to the rendered row
   * counts; tests that care about the split between "what is shown" and "what
   * exists" pass their own, and `null` stands for totals that have not loaded.
   */
  scopeTotals?: Totals | null;
  onDelete?: (path: string) => unknown;
} = {}) {
  const resolved =
    scopeTotals === undefined
      ? totals(objects.length, lists.length, events.length)
      : scopeTotals;

  apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "DELETE") return onDelete(path) as never;

    const route = routeOf(path);
    if (route === "/api/v1/brain/objects") return objects as never;
    if (route === "/api/v1/brain/lists") return lists as never;
    if (route === "/api/v1/brain/events") return events as never;
    if (route.startsWith("/api/v1/brain/lists/"))
      return { items: [], totalCount: 0, revision: 1 } as never;
    if (route === "/api/v1/brain/collections")
      return (
        resolved && collection ? [{ collection, ...resolved }] : []
      ) as never;
    if (route === "/api/v1/brain/projects")
      return (
        resolved && !collection
          ? ([{ repoRoot: REPO, ...resolved }] satisfies BrainProject[])
          : []
      ) as never;
    throw new Error(`unexpected request: ${path}`);
  });

  const onCollectionCleared = vi.fn();
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <BrainCollectionView
          repoRoot={REPO}
          collection={collection}
          search={search}
          onCollectionCleared={onCollectionCleared}
        />
      </QueryClientProvider>
    </MemoryRouter>
  );
  return { onCollectionCleared };
}

function deleteCalls(): string[] {
  return apiMock.mock.calls
    .filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "DELETE"
    )
    .map(([path]) => path as string);
}

function getCalls(route: string): string[] {
  return apiMock.mock.calls
    .filter(
      ([, init]) => (init as RequestInit | undefined)?.method === undefined
    )
    .map(([path]) => path as string)
    .filter((path) => routeOf(path) === route);
}

function findBulkButton(entryType: "objects" | "lists" | "events") {
  return screen.findByRole("button", {
    name: new RegExp(`^Delete all ${entryType} in `),
  });
}

async function openBulk(entryType: "objects" | "lists" | "events") {
  fireEvent.click(await findBulkButton(entryType));
}

function confirmDelete() {
  fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
}

beforeEach(() => {
  apiMock.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

afterEach(cleanup);

describe("bulk delete wire contract", () => {
  it("scopes the delete to the active collection and the section's entry type", async () => {
    mountView({ collection: "config", objects: [makeObject()] });

    await openBulk("objects");
    confirmDelete();

    await waitFor(() => expect(deleteCalls()).toHaveLength(1));
    expect(deleteCalls()[0]).toBe(
      "/api/v1/brain/objects?repoRoot=%2Frepo&collection=config"
    );
  });

  it("clears the entry type across every collection when none is selected", async () => {
    // The all-collections scope is a different query param, not an omitted
    // one — a dropped `collection` would otherwise read as "everything".
    mountView({ collection: null, lists: [makeList()] });

    await openBulk("lists");
    confirmDelete();

    await waitFor(() => expect(deleteCalls()).toHaveLength(1));
    expect(deleteCalls()[0]).toBe(
      "/api/v1/brain/lists?repoRoot=%2Frepo&allCollections=true"
    );
  });

  it("labels each delete-all action with its entry type and the active scope", async () => {
    mountView({
      collection: "config",
      objects: [makeObject()],
      lists: [makeList()],
      events: [makeEvent()],
    });

    expect(
      await screen.findByRole("button", {
        name: "Delete all objects in “config”",
      })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Delete all lists in “config”" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Delete all events in “config”",
      })
    ).toBeTruthy();

    cleanup();
    mountView({ collection: null, objects: [makeObject()] });
    expect(
      await screen.findByRole("button", {
        name: "Delete all objects in every collection",
      })
    ).toBeTruthy();
  });

  it("refetches brain data once the delete succeeds", async () => {
    mountView({ collection: "config", objects: [makeObject()] });
    await findBulkButton("objects");
    const before = getCalls("/api/v1/brain/objects").length;

    await openBulk("objects");
    confirmDelete();

    await waitFor(() =>
      expect(getCalls("/api/v1/brain/objects").length).toBeGreaterThan(before)
    );
  });
});

describe("honest counts", () => {
  it("quotes the scope total rather than the rows on screen", async () => {
    // The rendered list is capped and filtered; only the totals can say how
    // much a bulk delete actually destroys.
    mountView({
      collection: "config",
      search: "zzz",
      objects: [makeObject()],
      scopeTotals: totals(7, 0, 0),
    });

    await openBulk("objects");

    expect(
      screen.getByRole("heading", { name: "Delete 7 objects?" })
    ).toBeTruthy();
  });

  it("uses the singular noun for a scope holding one entry", async () => {
    mountView({
      collection: "config",
      objects: [makeObject()],
      scopeTotals: totals(1, 0, 0),
    });

    await openBulk("objects");

    expect(
      screen.getByRole("heading", { name: "Delete 1 object?" })
    ).toBeTruthy();
  });

  it("reports the server's deleted count in the toast, not the quoted total", async () => {
    // An agent writing while the dialog is open moves the totals; the response
    // is the only count that describes what really happened.
    mountView({
      collection: "config",
      objects: [makeObject()],
      scopeTotals: totals(7, 0, 0),
      onDelete: () => ({ deleted: 2 }),
    });

    await openBulk("objects");
    confirmDelete();

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Deleted 2 objects.")
    );
  });

  it("uses the singular noun when exactly one entry was deleted", async () => {
    mountView({
      collection: "config",
      objects: [makeObject()],
      onDelete: () => ({ deleted: 1 }),
    });

    await openBulk("objects");
    confirmDelete();

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Deleted 1 object.")
    );
  });

  it("does not offer bulk delete before the totals load", async () => {
    mountView({
      collection: "config",
      objects: [makeObject()],
      scopeTotals: null,
    });

    // Per-entry deletes need no totals and stay available.
    expect(
      await screen.findByRole("button", { name: "Delete object app-settings" })
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Delete all / })).toBeNull();
  });
});

describe("collection-cleared redirect", () => {
  it("leaves the collection when the bulk delete empties it", async () => {
    const { onCollectionCleared } = mountView({
      collection: "config",
      objects: [makeObject()],
      scopeTotals: totals(3, 0, 0),
    });

    await openBulk("objects");
    confirmDelete();

    await waitFor(() => expect(onCollectionCleared).toHaveBeenCalledTimes(1));
  });

  it("stays put when another entry type still has entries", async () => {
    const { onCollectionCleared } = mountView({
      collection: "config",
      objects: [makeObject()],
      scopeTotals: totals(3, 0, 1),
    });

    await openBulk("objects");
    confirmDelete();

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(onCollectionCleared).not.toHaveBeenCalled();
  });

  it("never redirects for an all-collections bulk delete", async () => {
    // Nothing is left in the project scope either, but there is no collection
    // route to leave — the redirect is about a collection ceasing to exist.
    const { onCollectionCleared } = mountView({
      collection: null,
      objects: [makeObject()],
      scopeTotals: totals(3, 0, 0),
    });

    await openBulk("objects");
    confirmDelete();

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(onCollectionCleared).not.toHaveBeenCalled();
  });
});

describe("failure handling", () => {
  it("keeps the confirmation open and reports the failure", async () => {
    mountView({
      collection: "config",
      objects: [makeObject()],
      scopeTotals: totals(3, 0, 0),
      onDelete: () => {
        throw new Error("500 Internal Server Error");
      },
    });

    await openBulk("objects");
    confirmDelete();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Could not delete brain data.")
    );
    expect(toastSuccess).not.toHaveBeenCalled();
    // Still open, so the operator can retry without hunting for the button.
    expect(
      screen.getByRole("heading", { name: "Delete 3 objects?" })
    ).toBeTruthy();
  });
});

describe("filtering", () => {
  it("matches objects and lists on their collection as well as their name", async () => {
    mountView({
      collection: null,
      search: "notes",
      objects: [
        makeObject({ collection: "notes", name: "app-settings" }),
        makeObject({ collection: "config", name: "unrelated" }),
      ],
      lists: [
        makeList({ collection: "notes", name: "task-queue" }),
        makeList({ collection: "config", name: "other-queue" }),
      ],
    });

    expect(await screen.findByText("app-settings")).toBeTruthy();
    expect(screen.getByText("task-queue")).toBeTruthy();
    expect(screen.queryByText("unrelated")).toBeNull();
    expect(screen.queryByText("other-queue")).toBeNull();
  });

  it("matches events on kind or subject and drops those without a subject", async () => {
    mountView({
      collection: null,
      search: "deploy",
      events: [
        makeEvent({ id: "evt_kind", kind: "deploy", subject: null }),
        makeEvent({ id: "evt_subject", kind: "run", subject: "deploy-web" }),
        makeEvent({ id: "evt_other", kind: "build", subject: null }),
      ],
    });

    expect(
      await screen.findByRole("button", { name: "Delete event deploy" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Delete event run" })
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Delete event build" })
    ).toBeNull();
  });

  it("keeps the sections mounted when the filter hides every row", async () => {
    // The delete-all actions live in the section headers and clear entries the
    // filter is hiding, so they have to survive an empty filter result.
    mountView({
      collection: "config",
      search: "zzz",
      objects: [makeObject()],
      scopeTotals: totals(4, 0, 0),
    });

    expect(
      await screen.findByText("No objects match the current filter.")
    ).toBeTruthy();
    expect(await findBulkButton("objects")).toBeTruthy();
  });

  it("shows the empty state only once the scope itself is empty", async () => {
    mountView({ collection: "config", scopeTotals: totals(0, 0, 0) });

    expect(
      await screen.findByText("No brain data in this collection yet.")
    ).toBeTruthy();

    cleanup();
    mountView({
      collection: "config",
      search: "zzz",
      scopeTotals: totals(0, 0, 0),
    });
    expect(
      await screen.findByText("No brain data matches your filter.")
    ).toBeTruthy();
  });

  it("warns about the 100-item cap only in an unfiltered project scope", async () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      makeEvent({ id: `evt_${i}`, kind: `kind-${i}` })
    );
    const capNote = "Showing the first 100 items per section.";

    mountView({ collection: null, events: many });
    expect(await screen.findByText(new RegExp(capNote))).toBeTruthy();

    cleanup();
    mountView({ collection: null, search: "zzz", events: many });
    // A filtered view is already showing a subset on purpose; the cap note
    // would be describing the wrong thing.
    expect(await screen.findByText(/match the current filter/)).toBeTruthy();
    expect(screen.queryByText(new RegExp(capNote))).toBeNull();

    cleanup();
    mountView({ collection: "config", events: many });
    expect(
      await screen.findByRole("button", { name: "Delete event kind-0" })
    ).toBeTruthy();
    expect(screen.queryByText(new RegExp(capNote))).toBeNull();
  });
});

describe("single-entry and whole-collection deletes", () => {
  it("encodes the collection and name of a single object delete", async () => {
    mountView({
      collection: "config",
      objects: [makeObject({ name: "a/b" })],
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Delete object a/b" })
    );
    confirmDelete();

    await waitFor(() => expect(deleteCalls()).toHaveLength(1));
    expect(deleteCalls()[0]).toBe(
      "/api/v1/brain/objects/config/a%2Fb?repoRoot=%2Frepo"
    );
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Object deleted.")
    );
  });

  it("clears a whole collection and reports the combined entry count", async () => {
    const { onCollectionCleared } = mountView({
      collection: "config",
      objects: [makeObject()],
      onDelete: () => ({ objects: 2, lists: 1, events: 3 }),
    });

    fireEvent.click(
      await screen.findByRole("button", { name: /Clear collection/ })
    );
    confirmDelete();

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "Deleted 6 entries from config."
      )
    );
    expect(deleteCalls()[0]).toBe(
      "/api/v1/brain/collections/config?repoRoot=%2Frepo"
    );
    expect(onCollectionCleared).toHaveBeenCalledTimes(1);
  });
});
