// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type MediaFile } from "@/components/app/types";

import { useMedia } from "./use-media";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);

const AGENT_ID = "agt_test";

function file(overrides: Partial<MediaFile> = {}): MediaFile {
  return {
    name: "report.md",
    size: 100,
    updatedAt: "2026-08-31T00:00:00Z",
    url: "/api/v1/agents/agt_test/media/report.md",
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

describe("useMedia lightbox identity", () => {
  it("keeps the lightbox open when the open file's updatedAt changes", async () => {
    let files: MediaFile[] = [file({ updatedAt: "2026-08-31T00:00:00Z" })];
    apiMock.mockImplementation(async () => ({ files }));

    const { result, rerender } = renderHook(() => useMedia(AGENT_ID, true), {
      wrapper,
    });

    await waitFor(() => expect(result.current.mediaFiles).toHaveLength(1));

    act(() => result.current.openLightbox(result.current.mediaFiles[0]));
    expect(result.current.lightboxItem?.file.name).toBe("report.md");

    // Simulate an agent rewriting the open file: same name, new updatedAt.
    files = [file({ updatedAt: "2026-08-31T00:05:00Z" })];
    await act(async () => {
      await result.current.refreshMedia(AGENT_ID);
    });
    rerender();

    await waitFor(() =>
      expect(result.current.mediaFiles[0]?.updatedAt).toBe(
        "2026-08-31T00:05:00Z"
      )
    );

    // The lookup is by stable name, so the item must still resolve — this
    // is what keeps MediaLightbox mounted instead of hitting `if (!item)
    // return null`.
    expect(result.current.lightboxItem).not.toBeNull();
    expect(result.current.lightboxItem?.file.updatedAt).toBe(
      "2026-08-31T00:05:00Z"
    );
    // The cache-buster still changes, so the refreshed content actually loads.
    expect(result.current.lightboxItem?.src).toContain(
      encodeURIComponent("2026-08-31T00:05:00Z")
    );
  });

  it("keeps navigation order stable when an update reorders the underlying list", async () => {
    // List is ordered by COALESCE(updated_at, created_at) DESC — updating a
    // file moves it to the front. Content still refreshes (that's looked up
    // by name, independent of order), but the reader's prev/next frame and
    // n/N must not reshuffle mid-read.
    let files: MediaFile[] = [
      file({ name: "a.md", updatedAt: "2026-08-31T00:00:00Z" }),
      file({ name: "b.md", updatedAt: "2026-08-30T00:00:00Z" }),
      file({ name: "c.md", updatedAt: "2026-08-29T00:00:00Z" }),
    ];
    apiMock.mockImplementation(async () => ({ files }));

    const { result, rerender } = renderHook(() => useMedia(AGENT_ID, true), {
      wrapper,
    });

    await waitFor(() => expect(result.current.mediaFiles).toHaveLength(3));

    // Open "c.md" — last in the list, index 2.
    act(() =>
      result.current.openLightbox(
        result.current.mediaFiles.find((f) => f.name === "c.md")!
      )
    );
    expect(result.current.lightboxIndex).toBe(2);
    expect(result.current.lightboxTotalItems).toBe(3);

    // "c.md" gets updated and jumps to the front of the underlying list.
    files = [
      file({ name: "c.md", updatedAt: "2026-08-31T00:10:00Z" }),
      file({ name: "a.md", updatedAt: "2026-08-31T00:00:00Z" }),
      file({ name: "b.md", updatedAt: "2026-08-30T00:00:00Z" }),
    ];
    await act(async () => {
      await result.current.refreshMedia(AGENT_ID);
    });
    rerender();

    await waitFor(() =>
      expect(result.current.lightboxItem?.file.updatedAt).toBe(
        "2026-08-31T00:10:00Z"
      )
    );
    // Content refreshed, but the reader's position in the frozen order
    // (still "c.md" last, index 2) is unchanged.
    expect(result.current.lightboxIndex).toBe(2);
    expect(result.current.lightboxItem?.file.name).toBe("c.md");
  });

  it("appends a newly-arrived file at the end instead of reordering an open session", async () => {
    let files: MediaFile[] = [
      file({ name: "a.md", updatedAt: "2026-08-31T00:00:00Z" }),
      file({ name: "b.md", updatedAt: "2026-08-30T00:00:00Z" }),
    ];
    apiMock.mockImplementation(async () => ({ files }));

    const { result, rerender } = renderHook(() => useMedia(AGENT_ID, true), {
      wrapper,
    });

    await waitFor(() => expect(result.current.mediaFiles).toHaveLength(2));

    // Open "a.md" — first (and only prior) item, index 0, nothing to go back to.
    act(() =>
      result.current.openLightbox(
        result.current.mediaFiles.find((f) => f.name === "a.md")!
      )
    );
    expect(result.current.lightboxIndex).toBe(0);
    expect(result.current.lightboxTotalItems).toBe(2);

    // An unrelated file is shared while the reader is mid-read. Sorted DESC,
    // it would land at index 0 live — but the open session's order must not
    // move "a.md" out from under the reader or silently enable "previous".
    files = [
      file({ name: "new.md", updatedAt: "2026-08-31T00:20:00Z" }),
      file({ name: "a.md", updatedAt: "2026-08-31T00:00:00Z" }),
      file({ name: "b.md", updatedAt: "2026-08-30T00:00:00Z" }),
    ];
    await act(async () => {
      await result.current.refreshMedia(AGENT_ID);
    });
    rerender();

    await waitFor(() => expect(result.current.mediaFiles).toHaveLength(3));
    expect(result.current.lightboxIndex).toBe(0);
    expect(result.current.lightboxItem?.file.name).toBe("a.md");
    // The new file is appended at the end of the frozen order, not inserted
    // ahead of "a.md".
    expect(result.current.lightboxTotalItems).toBe(3);
  });

  it("computes the correct index at open, not one refetch later", async () => {
    // The bug this pins: the frozen-order snapshot lived in a ref, and
    // lightboxOrder was a useMemo keyed on lightboxItems. A ref write
    // doesn't invalidate a memo, so closing a session (which reset the
    // snapshot) never forced a recompute either — lightboxOrder kept
    // showing that session's frozen order until some *unrelated* later
    // change to lightboxItems happened to refresh it. Opening a new
    // session in between read whatever stale value was left over: right
    // at open, not one refetch later.
    let files: MediaFile[] = [
      file({ name: "a.md", updatedAt: "2026-08-31T00:00:00Z" }),
      file({ name: "b.md", updatedAt: "2026-08-30T00:00:00Z" }),
      file({ name: "c.md", updatedAt: "2026-08-29T00:00:00Z" }),
    ];
    apiMock.mockImplementation(async () => ({ files }));

    const { result, rerender } = renderHook(() => useMedia(AGENT_ID, true), {
      wrapper,
    });

    await waitFor(() => expect(result.current.mediaFiles).toHaveLength(3));

    // Open "a.md" — this session's frozen order is [a,b,c].
    act(() =>
      result.current.openLightbox(
        result.current.mediaFiles.find((f) => f.name === "a.md")!
      )
    );

    // While "a.md" is still open, "c.md" gets updated and jumps to the
    // front live — the open session correctly stays frozen at [a,b,c]
    // (that's #2283's fix), so lightboxOrder is [a,b,c] going into close.
    files = [
      file({ name: "c.md", updatedAt: "2026-08-31T00:10:00Z" }),
      file({ name: "a.md", updatedAt: "2026-08-31T00:00:00Z" }),
      file({ name: "b.md", updatedAt: "2026-08-30T00:00:00Z" }),
    ];
    await act(async () => {
      await result.current.refreshMedia(AGENT_ID);
    });
    rerender();
    await waitFor(() =>
      expect(result.current.mediaFiles[0]?.name).toBe("c.md")
    );
    expect(result.current.lightboxIndex).toBe(0); // still "a.md", still frozen

    act(() => result.current.setLightboxIndex(null));

    // Open "b.md" — a fresh session, with no further mediaFiles change
    // after this call. Live order is [c,a,b], so "b.md" is at index 2 —
    // the stale session-1 frozen order ([a,b,c]) would instead put it at
    // index 1.
    act(() =>
      result.current.openLightbox(
        result.current.mediaFiles.find((f) => f.name === "b.md")!
      )
    );
    expect(result.current.lightboxIndex).toBe(2);
  });
});
