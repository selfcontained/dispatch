// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type FileItem } from "@/components/app/types";

import { fileItemQueryKey, useFiles } from "./use-files";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);

const AGENT_ID = "agt_test";

function file(overrides: Partial<FileItem> = {}): FileItem {
  return {
    id: 1,
    name: "report.md",
    size: 100,
    updatedAt: "2026-08-31T00:00:00Z",
    url: "/api/v1/agents/agt_test/files/report.md",
    ...overrides,
  };
}

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useFiles lightbox identity", () => {
  it("keeps the lightbox open when the open file's updatedAt changes", async () => {
    let files: FileItem[] = [file({ updatedAt: "2026-08-31T00:00:00Z" })];
    apiMock.mockImplementation(async () => ({ files }));

    const { result, rerender } = renderHook(() => useFiles(AGENT_ID, true), {
      wrapper,
    });

    await waitFor(() => expect(result.current.files).toHaveLength(1));

    act(() => result.current.openLightbox(result.current.files[0].id));
    expect(result.current.lightboxFileId).toBe(1);

    // Simulate an agent rewriting the open file: same name, new updatedAt.
    files = [file({ updatedAt: "2026-08-31T00:05:00Z" })];
    await act(async () => {
      await result.current.refreshFiles(AGENT_ID);
    });
    rerender();

    await waitFor(() =>
      expect(result.current.files[0]?.updatedAt).toBe("2026-08-31T00:05:00Z")
    );

    // The lookup is by stable name, so the item must still resolve — this
    // is what keeps FileLightbox mounted instead of hitting `if (!item)
    // return null`.
    expect(result.current.lightboxFileId).toBe(1);
    expect(
      queryClient.getQueryData<FileItem>(fileItemQueryKey(1))?.updatedAt
    ).toBe("2026-08-31T00:05:00Z");
  });

  it("keeps navigation order stable when an update reorders the underlying list", async () => {
    // List is ordered by COALESCE(updated_at, created_at) DESC — updating a
    // file moves it to the front. Content still refreshes (that's looked up
    // by name, independent of order), but the reader's prev/next frame and
    // n/N must not reshuffle mid-read.
    let files: FileItem[] = [
      file({ id: 1, name: "a.md", updatedAt: "2026-08-31T00:00:00Z" }),
      file({ id: 2, name: "b.md", updatedAt: "2026-08-30T00:00:00Z" }),
      file({ id: 3, name: "c.md", updatedAt: "2026-08-29T00:00:00Z" }),
    ];
    apiMock.mockImplementation(async () => ({ files }));

    const { result, rerender } = renderHook(() => useFiles(AGENT_ID, true), {
      wrapper,
    });

    await waitFor(() => expect(result.current.files).toHaveLength(3));

    // Open "c.md" — last in the list, index 2.
    act(() => result.current.openLightbox(3));
    expect(result.current.lightboxFileIds.indexOf(3)).toBe(2);
    expect(result.current.lightboxFileIds).toHaveLength(3);

    // "c.md" gets updated and jumps to the front of the underlying list.
    files = [
      file({ id: 3, name: "c.md", updatedAt: "2026-08-31T00:10:00Z" }),
      file({ id: 1, name: "a.md", updatedAt: "2026-08-31T00:00:00Z" }),
      file({ id: 2, name: "b.md", updatedAt: "2026-08-30T00:00:00Z" }),
    ];
    await act(async () => {
      await result.current.refreshFiles(AGENT_ID);
    });
    rerender();

    await waitFor(() =>
      expect(result.current.files[0]?.updatedAt).toBe("2026-08-31T00:10:00Z")
    );
    // Content refreshed, but the reader's position in the frozen order
    // (still "c.md" last, index 2) is unchanged.
    expect(result.current.lightboxFileIds.indexOf(3)).toBe(2);
    expect(result.current.lightboxFileId).toBe(3);
  });

  it("appends a newly-arrived file at the end instead of reordering an open session", async () => {
    let files: FileItem[] = [
      file({ id: 1, name: "a.md", updatedAt: "2026-08-31T00:00:00Z" }),
      file({ id: 2, name: "b.md", updatedAt: "2026-08-30T00:00:00Z" }),
    ];
    apiMock.mockImplementation(async () => ({ files }));

    const { result, rerender } = renderHook(() => useFiles(AGENT_ID, true), {
      wrapper,
    });

    await waitFor(() => expect(result.current.files).toHaveLength(2));

    // Open "a.md" — first (and only prior) item, index 0, nothing to go back to.
    act(() => result.current.openLightbox(1));
    expect(result.current.lightboxFileIds.indexOf(1)).toBe(0);
    expect(result.current.lightboxFileIds).toHaveLength(2);

    // An unrelated file is shared while the reader is mid-read. Sorted DESC,
    // it would land at index 0 live — but the open session's order must not
    // move "a.md" out from under the reader or silently enable "previous".
    files = [
      file({ id: 3, name: "new.md", updatedAt: "2026-08-31T00:20:00Z" }),
      file({ id: 1, name: "a.md", updatedAt: "2026-08-31T00:00:00Z" }),
      file({ id: 2, name: "b.md", updatedAt: "2026-08-30T00:00:00Z" }),
    ];
    await act(async () => {
      await result.current.refreshFiles(AGENT_ID);
    });
    rerender();

    await waitFor(() => expect(result.current.files).toHaveLength(3));
    expect(result.current.lightboxFileIds.indexOf(1)).toBe(0);
    expect(result.current.lightboxFileId).toBe(1);
    // The new file is appended at the end of the frozen order, not inserted
    // ahead of "a.md".
    expect(result.current.lightboxFileIds).toHaveLength(3);
  });

  it("computes the correct index at open, not one refetch later", async () => {
    // The bug this pins: the frozen-order snapshot lived in a ref, and
    // lightboxOrder was a useMemo keyed on the live item list. A ref write
    // doesn't invalidate a memo, so closing a session (which reset the
    // snapshot) never forced a recompute either — lightboxOrder kept
    // showing that session's frozen order until some *unrelated* later
    // change to lightboxItems happened to refresh it. Opening a new
    // session in between read whatever stale value was left over: right
    // at open, not one refetch later.
    let files: FileItem[] = [
      file({ id: 1, name: "a.md", updatedAt: "2026-08-31T00:00:00Z" }),
      file({ id: 2, name: "b.md", updatedAt: "2026-08-30T00:00:00Z" }),
      file({ id: 3, name: "c.md", updatedAt: "2026-08-29T00:00:00Z" }),
    ];
    apiMock.mockImplementation(async () => ({ files }));

    const { result, rerender } = renderHook(() => useFiles(AGENT_ID, true), {
      wrapper,
    });

    await waitFor(() => expect(result.current.files).toHaveLength(3));

    // Open "a.md" — this session's frozen order is [a,b,c].
    act(() => result.current.openLightbox(1));

    // While "a.md" is still open, "c.md" gets updated and jumps to the
    // front live — the open session correctly stays frozen at [a,b,c]
    // (that's #2283's fix), so lightboxOrder is [a,b,c] going into close.
    files = [
      file({ id: 3, name: "c.md", updatedAt: "2026-08-31T00:10:00Z" }),
      file({ id: 1, name: "a.md", updatedAt: "2026-08-31T00:00:00Z" }),
      file({ id: 2, name: "b.md", updatedAt: "2026-08-30T00:00:00Z" }),
    ];
    await act(async () => {
      await result.current.refreshFiles(AGENT_ID);
    });
    rerender();
    await waitFor(() => expect(result.current.files[0]?.name).toBe("c.md"));
    expect(result.current.lightboxFileIds.indexOf(1)).toBe(0);

    act(() => result.current.setLightboxFileId(null));

    // Open "b.md" — a fresh session, with no further files change
    // after this call. Live order is [c,a,b], so "b.md" is at index 2 —
    // the stale session-1 frozen order ([a,b,c]) would instead put it at
    // index 1.
    act(() => result.current.openLightbox(2));
    expect(result.current.lightboxFileIds.indexOf(2)).toBe(2);
  });

  it("opens a chat attachment before the files query contains it", async () => {
    apiMock.mockResolvedValue({ files: [] });
    const { result } = renderHook(() => useFiles(AGENT_ID, true), { wrapper });

    await waitFor(() => expect(apiMock).toHaveBeenCalled());

    act(() => result.current.openLightbox(99));

    expect(result.current.lightboxFileId).toBe(99);
    expect(result.current.lightboxFileIds).toEqual([99]);
  });

  it("takes the owner's correct order when a chat-opened item arrives later", async () => {
    let files: FileItem[] = [];
    apiMock.mockImplementation(async () => ({ files }));
    const { result, rerender } = renderHook(() => useFiles(AGENT_ID, true), {
      wrapper,
    });

    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    act(() => result.current.openLightbox(2));
    expect(result.current.lightboxFileIds).toEqual([2]);

    files = [
      file({ id: 1, name: "a.md" }),
      file({ id: 2, name: "b.md" }),
      file({ id: 3, name: "c.md" }),
    ];
    await act(async () => {
      await result.current.refreshFiles(AGENT_ID);
    });
    rerender();

    await waitFor(() =>
      expect(result.current.lightboxFileIds).toEqual([1, 2, 3])
    );
    expect(result.current.lightboxFileIds.indexOf(2)).toBe(1);

    files = [
      file({ id: 3, name: "c.md", updatedAt: "2026-08-31T00:10:00Z" }),
      file({ id: 1, name: "a.md" }),
      file({ id: 2, name: "b.md" }),
    ];
    await act(async () => {
      await result.current.refreshFiles(AGENT_ID);
    });
    rerender();

    await waitFor(() => expect(result.current.files[0]?.id).toBe(3));
    expect(result.current.lightboxFileIds).toEqual([1, 2, 3]);
  });
});

describe("useFiles sub agent files", () => {
  const CHILD = {
    id: "agt_child",
    name: "builder",
    status: "running" as const,
    workspaceRoot: null,
  };

  function mockPerAgent(byAgent: Record<string, FileItem[]>) {
    apiMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/files/seen")) return { ok: true };
      const id = /agents\/([^/]+)\/files/.exec(path)?.[1] ?? "";
      return { files: byAgent[id] ?? [] };
    });
  }

  it("lists each child's files stamped with its owner and counts them unseen", async () => {
    mockPerAgent({
      [AGENT_ID]: [file({ id: 1, name: "own.png", seen: true })],
      agt_child: [
        file({
          id: 2,
          name: "shot.png",
          url: "/api/v1/agents/agt_child/files/shot.png",
        }),
      ],
    });
    const subAgents = [CHILD];
    const { result } = renderHook(() => useFiles(AGENT_ID, true, subAgents), {
      wrapper,
    });

    await waitFor(() =>
      expect(result.current.subAgentFiles[0]?.files).toHaveLength(1)
    );
    expect(result.current.files[0]?.ownerAgentId).toBe(AGENT_ID);
    expect(result.current.subAgentFiles[0]?.agent).toBe(CHILD);
    expect(result.current.subAgentFiles[0]?.files[0]?.ownerAgentId).toBe(
      "agt_child"
    );
    // Own file is seen, the child's is not: the badge counts the child's.
    expect(result.current.unseenFileCount).toBe(1);
  });

  it("shows one owner's files at a time and scopes the lightbox to them", async () => {
    mockPerAgent({
      [AGENT_ID]: [file({ id: 1, name: "own.png" })],
      agt_child: [file({ id: 2, name: "shot.png" })],
    });
    const subAgents = [CHILD];
    const { result } = renderHook(() => useFiles(AGENT_ID, true, subAgents), {
      wrapper,
    });
    await waitFor(() =>
      expect(result.current.subAgentFiles[0]?.files).toHaveLength(1)
    );

    expect(result.current.filesOwnerId).toBeNull();
    expect(result.current.visibleFiles.map((f) => f.name)).toEqual(["own.png"]);
    act(() => result.current.setFilesOwnerId("agt_child"));
    expect(result.current.filesOwnerId).toBe("agt_child");
    expect(result.current.visibleFiles.map((f) => f.name)).toEqual([
      "shot.png",
    ]);

    act(() => result.current.openLightbox(2));
    expect(result.current.lightboxFileIds).toEqual([2]);
    expect(result.current.lightboxFileId).toBe(2);

    // A sub agent that disappears falls back to the agent's own files.
    act(() => result.current.setFilesOwnerId("agt_gone"));
    expect(result.current.filesOwnerId).toBeNull();
    expect(result.current.visibleFiles[0]?.name).toBe("own.png");
  });

  it("opens a parent chat image while the Files tab shows a child", async () => {
    mockPerAgent({
      [AGENT_ID]: [file({ id: 1, name: "own.png" })],
      agt_child: [file({ id: 2, name: "shot.png" })],
    });
    const { result } = renderHook(() => useFiles(AGENT_ID, true, [CHILD]), {
      wrapper,
    });
    await waitFor(() =>
      expect(result.current.subAgentFiles[0]?.files).toHaveLength(1)
    );

    act(() => result.current.setFilesOwnerId("agt_child"));
    expect(result.current.visibleFiles[0]?.name).toBe("shot.png");

    act(() => result.current.openLightbox(1));

    expect(result.current.lightboxFileId).toBe(1);
    expect(result.current.lightboxFileIds).toEqual([1]);
  });

  it("marks a child's file seen against the child, not the parent", async () => {
    mockPerAgent({
      [AGENT_ID]: [],
      agt_child: [file({ id: 2, name: "shot.png" })],
    });
    // Stand in for the panel: a card carrying the child's owner attribute
    // inside the viewport the observer watches.
    const root = document.createElement("div");
    const card = document.createElement("article");
    card.dataset.fileKey = "shot.png:2026-08-31T00:00:00Z";
    card.dataset.filesOwner = "agt_child";
    root.appendChild(card);
    document.body.appendChild(root);

    let callback: IntersectionObserverCallback | null = null;
    const observe = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: IntersectionObserverCallback) {
          callback = cb;
        }
        observe = observe;
        disconnect = vi.fn();
      }
    );
    try {
      const subAgents = [CHILD];
      const { result } = renderHook(() => useFiles(AGENT_ID, true, subAgents), {
        wrapper,
      });
      // Attach the viewport before the files land, so the observer effect
      // that re-runs on the new file list finds it.
      (
        result.current.drawerViewportRef as { current: HTMLDivElement | null }
      ).current = root;
      await waitFor(() =>
        expect(result.current.subAgentFiles[0]?.files).toHaveLength(1)
      );
      await waitFor(() => expect(observe).toHaveBeenCalled());

      act(() => {
        callback?.(
          [
            {
              isIntersecting: true,
              target: card,
            } as unknown as IntersectionObserverEntry,
          ],
          {} as IntersectionObserver
        );
      });

      expect(apiMock).toHaveBeenCalledWith(
        "/api/v1/agents/agt_child/files/seen",
        expect.objectContaining({ method: "POST" })
      );
      expect(
        apiMock.mock.calls.some(([path]) =>
          String(path).startsWith(`/api/v1/agents/${AGENT_ID}/files/seen`)
        )
      ).toBe(false);
      await waitFor(() =>
        expect(result.current.subAgentFiles[0]?.files[0]?.seen).toBe(true)
      );
    } finally {
      vi.unstubAllGlobals();
      root.remove();
    }
  });
});
