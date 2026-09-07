// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type MediaFile } from "@/components/app/types";
import { mediaItemQueryKey } from "@/hooks/use-media";
import { ApiError } from "@/lib/api";

import { MediaLightbox } from "./media-lightbox";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);

function file(updatedAt: string): MediaFile {
  return {
    id: 7,
    ownerAgentId: "agt_owner",
    name: "shot.png",
    source: "screenshot",
    size: 2048,
    updatedAt,
    url: "/api/v1/agents/agt_owner/media/shot.png",
    description: "Current shot",
  };
}

function queryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function pendingRequest(): Promise<never> {
  return new Promise(() => {});
}

beforeEach(() => {
  apiMock.mockReset();
});

afterEach(cleanup);

describe("MediaLightbox", () => {
  it("paints seeded media immediately and refreshes its cache-busted URL", async () => {
    apiMock.mockImplementation(pendingRequest);
    const client = queryClient();
    client.setQueryData(mediaItemQueryKey(7), file("2026-08-31T00:00:00Z"));

    render(
      <QueryClientProvider client={client}>
        <MediaLightbox mediaId={7} mediaIds={[7]} setMediaId={vi.fn()} />
      </QueryClientProvider>
    );

    expect(screen.queryByText("Loading media…")).toBeNull();
    expect(screen.getByAltText("Current shot").getAttribute("src")).toContain(
      "2026-08-31T00%3A00%3A00Z"
    );

    act(() => {
      client.setQueryData(mediaItemQueryKey(7), file("2026-08-31T00:05:00Z"));
    });

    await waitFor(() =>
      expect(screen.getByAltText("Current shot").getAttribute("src")).toContain(
        "2026-08-31T00%3A05%3A00Z"
      )
    );
  });

  it("keeps navigation, safe-area chrome, focus, and status while loading", () => {
    apiMock.mockImplementation(pendingRequest);
    const client = queryClient();

    render(
      <QueryClientProvider client={client}>
        <MediaLightbox mediaId={5} mediaIds={[4, 5, 6]} setMediaId={vi.fn()} />
      </QueryClientProvider>
    );

    expect(screen.getByRole("status").textContent).toContain("Loading media…");
    expect(
      (screen.getByTestId("media-lightbox-prev") as HTMLButtonElement).disabled
    ).toBe(false);
    expect(
      (screen.getByTestId("media-lightbox-next") as HTMLButtonElement).disabled
    ).toBe(false);
    expect(screen.getByText("2/3")).toBeTruthy();
    const close = screen.getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(close);
    expect(close.parentElement?.parentElement?.className).toContain(
      "pt-[max(0.5rem,env(safe-area-inset-top))]"
    );
  });

  it("announces a transient error and retries without closing", async () => {
    apiMock
      .mockRejectedValueOnce(new ApiError(503, "Unavailable"))
      .mockResolvedValueOnce({ media: file("2026-08-31T00:05:00Z") });
    const client = queryClient();
    const setMediaId = vi.fn();

    render(
      <QueryClientProvider client={client}>
        <MediaLightbox mediaId={7} mediaIds={[7]} setMediaId={setMediaId} />
      </QueryClientProvider>
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Unable to load this media item."
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByAltText("Current shot")).toBeTruthy();
    expect(setMediaId).not.toHaveBeenCalledWith(null);
  });

  it("closes when a cached media item is deleted", async () => {
    apiMock.mockRejectedValue(new ApiError(404, "Media item not found."));
    const client = queryClient();
    client.setQueryData(mediaItemQueryKey(7), file("2026-08-31T00:00:00Z"));
    const setMediaId = vi.fn();

    render(
      <QueryClientProvider client={client}>
        <MediaLightbox mediaId={7} mediaIds={[7]} setMediaId={setMediaId} />
      </QueryClientProvider>
    );

    await waitFor(() => expect(setMediaId).toHaveBeenCalledWith(null));
    expect(screen.queryByTestId("media-lightbox")).toBeNull();
  });

  it("keeps cached content visible after a transient refresh failure", async () => {
    apiMock.mockRejectedValue(new ApiError(503, "Unavailable"));
    const client = queryClient();
    client.setQueryData(mediaItemQueryKey(7), file("2026-08-31T00:00:00Z"));

    render(
      <QueryClientProvider client={client}>
        <MediaLightbox mediaId={7} mediaIds={[7]} setMediaId={vi.fn()} />
      </QueryClientProvider>
    );

    await waitFor(() =>
      expect(client.getQueryState(mediaItemQueryKey(7))?.status).toBe("error")
    );
    expect(screen.getByAltText("Current shot")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
