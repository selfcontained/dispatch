// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MarkdownViewer } from "@/components/app/media-lightbox-text";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockFetchOnce(text: string) {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(text, { status: 200 })
  );
}

describe("MarkdownViewer", () => {
  // The container div only renders once content is loaded, so scroll
  // position (which lives on that div) survives a swap only if the div
  // stays mounted across it — i.e. content must not get cleared to null.
  it("keeps prior content mounted (no loading flash) when the same file refreshes", async () => {
    mockFetchOnce("# v1");
    const { rerender } = render(
      <MarkdownViewer src="/media/report.md?t=1" fileName="report.md" />
    );
    await waitFor(() => expect(screen.getByText("v1")).toBeTruthy());

    mockFetchOnce("# v2");
    // Same fileName, new cache-busted src — an in-place content refresh.
    rerender(
      <MarkdownViewer src="/media/report.md?t=2" fileName="report.md" />
    );

    // The old heading must still be on screen immediately after the src
    // change (no unmount to the loading placeholder) ...
    expect(screen.getByText("v1")).toBeTruthy();
    expect(screen.queryByText("Loading...")).toBeNull();

    // ... and once the new fetch resolves, it swaps in place.
    await waitFor(() => expect(screen.getByText("v2")).toBeTruthy());
  });

  it("shows the loading state when navigating to a different file", async () => {
    mockFetchOnce("# v1");
    const { rerender } = render(
      <MarkdownViewer src="/media/report.md?t=1" fileName="report.md" />
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
});
