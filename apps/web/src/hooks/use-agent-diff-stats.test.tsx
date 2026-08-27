// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { diffHideTestFilesAtom } from "@/lib/store";

import { useAgentDiff } from "./use-agent-diff";
import { useAgentDiffStats, useVisibleDiffStats } from "./use-agent-diff-stats";
import { diffFileTotals, useVisibleDiffFiles } from "./use-visible-diff";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);

// The server computes stats without `-w`, so its totals include a
// whitespace-only 4th file that the `-w` diff below never lists. Its
// excluding-tests cut drops `src/app.test.ts` (15/8) from the same numbers.
const SERVER_STATS = {
  added: 123,
  deleted: 43,
  files: 4,
  excludingTests: { added: 108, deleted: 35, files: 3 },
  computedAt: 1_000,
};

/** What every badge shows from the server totals with the filter on. */
const SERVER_STATS_HIDING_TESTS = {
  ...SERVER_STATS,
  added: 108,
  deleted: 35,
  files: 3,
};

// `isTest` comes from the server, so the fixture carries it the way the wire
// does rather than re-deriving it from the path here.
const DIFF_FILES = [
  { path: "src/app.ts", status: "modified", added: 100, deleted: 30 },
  { path: "src/app.test.ts", status: "modified", added: 15, deleted: 8 },
  { path: "docs/api-spec.md", status: "modified", added: 5, deleted: 2 },
].map((file) => ({
  ...file,
  diff: null,
  truncated: false,
  isTest: file.path === "src/app.test.ts",
}));

function respond(diffOverrides: Record<string, unknown> = {}) {
  apiMock.mockImplementation(async (url: string) => {
    if (url.includes("/diff-stats")) return { diffStats: SERVER_STATS };
    return { baseRef: "abc123", files: DIFF_FILES, ...diffOverrides };
  });
}

let queryClient: QueryClient;
let store: ReturnType<typeof createStore>;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>{children}</Provider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  store = createStore();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  apiMock.mockReset();
});

describe("useAgentDiffStats", () => {
  // The sidebar card and the session settings dialog show a badge with no
  // file list next to it, so the setting has to reach them through the
  // server's excluding-tests totals.
  it("honours the hide-test-files setting with no diff fetched", async () => {
    respond();
    store.set(diffHideTestFilesAtom, true);

    const { result } = renderHook(() => useAgentDiffStats("a1", true), {
      wrapper,
    });

    await waitFor(() =>
      expect(result.current.diffStats).toEqual(SERVER_STATS_HIDING_TESTS)
    );
    expect(
      apiMock.mock.calls.some(([url]) => String(url).includes("/diff?"))
    ).toBe(false);
  });

  it("reports the full totals with the setting off", async () => {
    respond();
    store.set(diffHideTestFilesAtom, false);

    const { result } = renderHook(() => useAgentDiffStats("a1", true), {
      wrapper,
    });

    await waitFor(() => expect(result.current.diffStats).toEqual(SERVER_STATS));
  });

  it("follows the setting without refetching", async () => {
    respond();
    store.set(diffHideTestFilesAtom, false);

    const { result } = renderHook(() => useAgentDiffStats("a1", true), {
      wrapper,
    });

    await waitFor(() => expect(result.current.diffStats?.files).toBe(4));
    const callsBefore = apiMock.mock.calls.length;
    store.set(diffHideTestFilesAtom, true);

    await waitFor(() => expect(result.current.diffStats?.files).toBe(3));
    expect(apiMock.mock.calls.length).toBe(callsBefore);
  });

  it("falls back to the full totals when the server omits the split", async () => {
    const { excludingTests, ...legacy } = SERVER_STATS;
    void excludingTests;
    apiMock.mockImplementation(async () => ({ diffStats: legacy }));
    store.set(diffHideTestFilesAtom, true);

    const { result } = renderHook(() => useAgentDiffStats("a1", true), {
      wrapper,
    });

    await waitFor(() => expect(result.current.diffStats?.added).toBe(123));
    expect(result.current.diffStats?.files).toBe(4);
  });
});

describe("useVisibleDiffStats", () => {
  it("subtracts hidden test files from the totals on the changes tab", async () => {
    respond();
    store.set(diffHideTestFilesAtom, true);

    const { result } = renderHook(() => useVisibleDiffStats("a1", true, true), {
      wrapper,
    });

    await waitFor(() =>
      expect(result.current.diffStats).toEqual({
        ...SERVER_STATS,
        added: 105,
        deleted: 32,
        files: 2,
      })
    );
  });

  it("reports exactly the totals of the list the changes tab renders", async () => {
    respond();
    store.set(diffHideTestFilesAtom, true);

    const { result } = renderHook(
      () => {
        const { data } = useAgentDiff("a1", true, true);
        return {
          listed: diffFileTotals(useVisibleDiffFiles(data)),
          badge: useVisibleDiffStats("a1", true, true).diffStats,
        };
      },
      { wrapper }
    );

    await waitFor(() => expect(result.current.badge?.files).toBe(2));
    expect(result.current.badge).toMatchObject(result.current.listed);
  });

  it("drops whitespace-only files the list omits, test filter off", async () => {
    respond();
    store.set(diffHideTestFilesAtom, false);

    const { result } = renderHook(() => useVisibleDiffStats("a1", true, true), {
      wrapper,
    });

    await waitFor(() =>
      expect(result.current.diffStats).toEqual({
        ...SERVER_STATS,
        added: 120,
        deleted: 40,
        files: 3,
      })
    );
  });

  it("keeps the server totals when the file list was truncated", async () => {
    respond({ truncatedFileCount: 4_000 });
    store.set(diffHideTestFilesAtom, true);

    const { result } = renderHook(() => useVisibleDiffStats("a1", true, true), {
      wrapper,
    });

    await waitFor(() =>
      expect(
        apiMock.mock.calls.some(([url]) => String(url).includes("/diff?"))
      ).toBe(true)
    );
    await waitFor(() =>
      expect(result.current.diffStats).toEqual(SERVER_STATS_HIDING_TESTS)
    );
  });

  it("uses live server totals, and fetches no diff, while the tab is closed", async () => {
    respond();
    store.set(diffHideTestFilesAtom, true);

    const { result } = renderHook(
      () => useVisibleDiffStats("a1", true, false),
      { wrapper }
    );

    await waitFor(() =>
      expect(result.current.diffStats).toEqual(SERVER_STATS_HIDING_TESTS)
    );
    expect(
      apiMock.mock.calls.some(([url]) => String(url).includes("/diff?"))
    ).toBe(false);
  });

  it("does not serve a stale cached diff after the tab closes", async () => {
    respond();
    store.set(diffHideTestFilesAtom, true);

    const view = renderHook(
      ({ visible }: { visible: boolean }) =>
        useVisibleDiffStats("a1", true, visible),
      { wrapper, initialProps: { visible: true } }
    );

    await waitFor(() => expect(view.result.current.diffStats?.files).toBe(2));

    // The diff stays cached, but the badge must follow the still-polling
    // server totals rather than freeze on that snapshot.
    view.rerender({ visible: false });
    await waitFor(() =>
      expect(view.result.current.diffStats).toEqual(SERVER_STATS_HIDING_TESTS)
    );
  });

  it("refresh invalidates the diff alongside the stats", async () => {
    respond();
    store.set(diffHideTestFilesAtom, true);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useVisibleDiffStats("a1", true, true), {
      wrapper,
    });

    await waitFor(() => expect(result.current.diffStats?.files).toBe(2));
    result.current.refresh();

    const keys = invalidate.mock.calls.map(([arg]) =>
      JSON.stringify(arg?.queryKey)
    );
    expect(keys.some((key) => key?.includes("agent-diff-content"))).toBe(true);
    expect(keys.some((key) => key?.includes('["agent-diff"'))).toBe(true);
  });
});
