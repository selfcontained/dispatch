// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MarkdownViewer } from "@/components/app/media-lightbox-text";

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockFetchOnce(text: string) {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(text, { status: 200 })
  );
}

// The hook retries once (retry: 1) before giving up — queue both responses
// so the failure path is deterministic rather than falling through to a
// real (network-less, jsdom) fetch on the second call.
function mockFetchFailTwice(status = 500) {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("nope", { status }))
    .mockResolvedValueOnce(new Response("nope", { status }));
}

describe("MarkdownViewer", () => {
  // The container div only renders once content is loaded, so scroll
  // position (which lives on that div) survives a swap only if the div
  // stays mounted across it — i.e. content must not get cleared to null,
  // and the DOM node itself must not be recreated.
  it("keeps the same scroll container mounted when the same file refreshes", async () => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockFetchOnce("# v1");
    const { container, rerender } = render(
      <MarkdownViewer src="/media/report.md?t=1" fileName="report.md" />,
      { wrapper }
    );
    await waitFor(() => expect(screen.getByText("v1")).toBeTruthy());
    const scroller = container.querySelector(".overflow-auto");
    expect(scroller).toBeTruthy();

    mockFetchOnce("# v2");
    // Same fileName, new cache-busted src — an in-place content refresh.
    rerender(
      <MarkdownViewer src="/media/report.md?t=2" fileName="report.md" />
    );

    // The old heading must still be on screen immediately after the src
    // change (no unmount to the loading placeholder) ...
    expect(screen.getByText("v1")).toBeTruthy();
    expect(screen.queryByText("Loading...")).toBeNull();

    // ... and once the new fetch resolves, it swaps in place on the same
    // node — that's the actual property scrollTop preservation depends on.
    await waitFor(() => expect(screen.getByText("v2")).toBeTruthy());
    expect(container.querySelector(".overflow-auto")).toBe(scroller);
  });

  it("shows the loading state when navigating to a different file", async () => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockFetchOnce("# v1");
    const { rerender } = render(
      <MarkdownViewer src="/media/report.md?t=1" fileName="report.md" />,
      { wrapper }
    );
    await waitFor(() => expect(screen.getByText("v1")).toBeTruthy());

    let resolveFetch: (value: Response) => void = () => {};
    vi.spyOn(globalThis, "fetch").mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );
    // Different fileName — a real navigation via the prev/next arrows.
    rerender(<MarkdownViewer src="/media/other.md?t=1" fileName="other.md" />);

    await waitFor(() => expect(screen.getByText("Loading...")).toBeTruthy());
    expect(screen.queryByText("v1")).toBeNull();

    resolveFetch(new Response("# other", { status: 200 }));
    await waitFor(() => expect(screen.getByText("other")).toBeTruthy());
  });

  it("shows an error (after one retry) when a refresh fails, without crashing", async () => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockFetchOnce("# v1");
    const { rerender } = render(
      <MarkdownViewer src="/media/report.md?t=1" fileName="report.md" />,
      { wrapper }
    );
    await waitFor(() => expect(screen.getByText("v1")).toBeTruthy());

    // The refresh fails outright (e.g. the file was deleted). No retained-
    // content fallback — a plain error, same as a first-load failure.
    mockFetchFailTwice();
    rerender(
      <MarkdownViewer src="/media/report.md?t=2" fileName="report.md" />
    );

    await waitFor(() =>
      expect(screen.getByText(/Failed to load/)).toBeTruthy()
    );
  }, 10_000);
});
