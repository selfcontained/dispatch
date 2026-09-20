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

import { type FileItem } from "@/components/app/types";
import { fileItemQueryKey } from "@/hooks/use-files";
import { ApiError } from "@/lib/api";

import { FileLightbox } from "./file-lightbox";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);

function file(updatedAt: string): FileItem {
  return {
    id: 7,
    ownerAgentId: "agt_owner",
    name: "shot.png",
    source: "screenshot",
    size: 2048,
    updatedAt,
    url: "/api/v1/agents/agt_owner/files/shot.png",
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

describe("FileLightbox", () => {
  it("paints a seeded file immediately and refreshes its cache-busted URL", async () => {
    apiMock.mockImplementation(pendingRequest);
    const client = queryClient();
    client.setQueryData(fileItemQueryKey(7), file("2026-08-31T00:00:00Z"));

    render(
      <QueryClientProvider client={client}>
        <FileLightbox fileId={7} fileIds={[7]} setFileId={vi.fn()} />
      </QueryClientProvider>
    );

    expect(screen.queryByText("Loading file…")).toBeNull();
    expect(screen.getByAltText("Current shot").getAttribute("src")).toContain(
      "2026-08-31T00%3A00%3A00Z"
    );

    act(() => {
      client.setQueryData(fileItemQueryKey(7), file("2026-08-31T00:05:00Z"));
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
        <FileLightbox fileId={5} fileIds={[4, 5, 6]} setFileId={vi.fn()} />
      </QueryClientProvider>
    );

    expect(screen.getByRole("status").textContent).toContain("Loading file…");
    expect(
      (screen.getByTestId("file-lightbox-prev") as HTMLButtonElement).disabled
    ).toBe(false);
    expect(
      (screen.getByTestId("file-lightbox-next") as HTMLButtonElement).disabled
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
      .mockResolvedValueOnce({ file: file("2026-08-31T00:05:00Z") });
    const client = queryClient();
    const setFileId = vi.fn();

    render(
      <QueryClientProvider client={client}>
        <FileLightbox fileId={7} fileIds={[7]} setFileId={setFileId} />
      </QueryClientProvider>
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Unable to load this file item."
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByAltText("Current shot")).toBeTruthy();
    expect(setFileId).not.toHaveBeenCalledWith(null);
  });

  it("closes when a cached file item is deleted", async () => {
    apiMock.mockRejectedValue(new ApiError(404, "File not found."));
    const client = queryClient();
    client.setQueryData(fileItemQueryKey(7), file("2026-08-31T00:00:00Z"));
    const setFileId = vi.fn();

    render(
      <QueryClientProvider client={client}>
        <FileLightbox fileId={7} fileIds={[7]} setFileId={setFileId} />
      </QueryClientProvider>
    );

    await waitFor(() => expect(setFileId).toHaveBeenCalledWith(null));
    expect(screen.queryByTestId("file-lightbox")).toBeNull();
  });

  it("keeps cached content visible after a transient refresh failure", async () => {
    apiMock.mockRejectedValue(new ApiError(503, "Unavailable"));
    const client = queryClient();
    client.setQueryData(fileItemQueryKey(7), file("2026-08-31T00:00:00Z"));

    render(
      <QueryClientProvider client={client}>
        <FileLightbox fileId={7} fileIds={[7]} setFileId={vi.fn()} />
      </QueryClientProvider>
    );

    await waitFor(() =>
      expect(client.getQueryState(fileItemQueryKey(7))?.status).toBe("error")
    );
    expect(screen.getByAltText("Current shot")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
