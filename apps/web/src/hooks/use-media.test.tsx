// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
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

  it("tracks the open item's new position when an update reorders the list", async () => {
    // List is ordered by COALESCE(updated_at, created_at) DESC — updating a
    // file moves it to the front.
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

    // "c.md" gets updated and jumps to the front of the list.
    files = [
      file({ name: "c.md", updatedAt: "2026-08-31T00:10:00Z" }),
      file({ name: "a.md", updatedAt: "2026-08-31T00:00:00Z" }),
      file({ name: "b.md", updatedAt: "2026-08-30T00:00:00Z" }),
    ];
    await act(async () => {
      await result.current.refreshMedia(AGENT_ID);
    });
    rerender();

    await waitFor(() => expect(result.current.lightboxIndex).toBe(0));
    expect(result.current.lightboxItem?.file.name).toBe("c.md");
    // Now at the front: no previous item.
    expect(result.current.lightboxIndex).toBe(0);
  });
});
