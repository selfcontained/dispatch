// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HistoryFile } from "@/hooks/use-agent-history";

import { DetailTabs } from "./agent-history-detail-tabs";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);

// Strip the animation layer so expanded content mounts synchronously.
vi.mock("framer-motion", async (importOriginal) => {
  const { createFramerMotionMock } =
    await import("@/test-utils/framer-motion-mock");
  return createFramerMotionMock(importOriginal);
});

const AGENT_ID = "agt_history";

function makeFile(overrides: Partial<HistoryFile> = {}): HistoryFile {
  return {
    id: 1,
    file_name: "shot-2026-07-20-10-00-00-111.png",
    source: "screenshot",
    size_bytes: 2048,
    description: "A screenshot",
    created_at: "2026-07-20T10:00:00.000Z",
    ...overrides,
  };
}

function renderTabs(
  overrides: Partial<React.ComponentProps<typeof DetailTabs>> = {}
) {
  const files = overrides.files ?? [];
  apiMock.mockImplementation(async (requestPath: string) => {
    const fileId = Number(requestPath.split("/").pop());
    const item = files.find((candidate) => candidate.id === fileId);
    if (!item) throw new Error("File not found");
    return {
      file: {
        id: item.id,
        ownerAgentId: AGENT_ID,
        name: item.file_name,
        source: item.source,
        size: item.size_bytes,
        updatedAt: item.created_at,
        description: item.description,
        url: `/api/v1/agents/${AGENT_ID}/files/${encodeURIComponent(item.file_name)}`,
      },
    };
  });
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <DetailTabs files={[]} agentId={AGENT_ID} {...overrides} />
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

describe("DetailTabs", () => {
  it("shows an empty file state", () => {
    renderTabs();
    expect(screen.getByText("No files captured.")).toBeTruthy();
  });

  it("renders screenshot tiles as images with encoded file URLs and text tiles as placeholders", () => {
    renderTabs({
      files: [
        makeFile({
          id: 1,
          file_name: "my shot-2026-07-20-10-00-00-111.png",
          description: "Login page",
        }),
        makeFile({
          id: 2,
          file_name: "capture-2026-07-20-10-00-00-222.mp4",
          source: "stream",
          description: null,
        }),
        makeFile({
          id: 3,
          file_name: "sim-2026-07-20-10-00-00-333.png",
          source: "simulator",
          description: "Simulator frame",
        }),
      ],
    });

    const img = screen.getByAltText("Login page");
    expect(img.getAttribute("src")).toBe(
      `/api/v1/agents/${AGENT_ID}/files/my%20shot-2026-07-20-10-00-00-111.png`
    );
    // The tile caption comes from the description, and only when present.
    expect(screen.getByText("Login page")).toBeTruthy();
    // Non-image sources render a source placeholder instead of an <img>.
    expect(screen.getByText("stream")).toBeTruthy();
    // Simulator captures are the other half of the image guard.
    expect(screen.getByAltText("Simulator frame")).toBeTruthy();
  });

  it("opens the lightbox at the clicked ID with a stripped-timestamp caption fallback", async () => {
    renderTabs({
      files: [
        makeFile({
          id: 1,
          file_name: "first-2026-07-20-10-00-00-111.png",
          description: "First shot",
        }),
        makeFile({
          id: 2,
          file_name: "second-2026-07-20-10-00-00-222.png",
          description: null,
        }),
        makeFile({
          id: 3,
          file_name: "third-2026-07-20-10-00-00-333.png",
          description: "Third shot",
        }),
      ],
    });
    expect(screen.queryByTestId("file-lightbox")).toBeNull();

    // Second tile has no description, so its alt falls back to the file name.
    fireEvent.click(
      screen
        .getByAltText("second-2026-07-20-10-00-00-222.png")
        .closest("button")!
    );

    expect(screen.queryByText("Loading file…")).toBeNull();
    await screen.findByText("second.png");
    const lightbox = within(screen.getByTestId("file-lightbox"));
    expect(apiMock).toHaveBeenCalledWith("/api/v1/files/2");
    // Caption falls back to the timestamp-stripped file name.
    expect(lightbox.getByText("second.png")).toBeTruthy();
    // Index and count both reached the lightbox.
    expect(lightbox.getByText("2/3")).toBeTruthy();

    // ArrowRight advances to the third item, proving index wiring is live
    // state (not a snapshot) and totalItems permits forward navigation.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    const thirdLightbox = within(screen.getByTestId("file-lightbox"));
    await thirdLightbox.findByText("Third shot");
    expect(thirdLightbox.getByText("3/3")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("file-lightbox")).toBeNull();
  });
});
