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

import type { AgentPin } from "@/components/app/types";
import type {
  HistoryEvent,
  HistoryFeedbackItem,
  HistoryMedia,
} from "@/hooks/use-agent-history";
import type { AgentMessage } from "@/hooks/use-agent-messages";

import { DetailTabs } from "./agent-history-detail-tabs";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);

// The messages tab renders HistoryThreadGroup's AnimatePresence collapse;
// strip the animation layer so expanded content mounts synchronously.
vi.mock("framer-motion", async (importOriginal) => {
  const { createFramerMotionMock } =
    await import("@/test-utils/framer-motion-mock");
  return createFramerMotionMock(importOriginal);
});

const AGENT_ID = "agt_history";

function makeEvent(id: number, message: string): HistoryEvent {
  return {
    id,
    event_type: "working",
    message,
    metadata: {},
    created_at: "2026-07-20T10:00:00.000Z",
  };
}

function makeMedia(overrides: Partial<HistoryMedia> = {}): HistoryMedia {
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

function makeFeedback(id: number, description: string): HistoryFeedbackItem {
  return {
    id,
    agentId: AGENT_ID,
    persona: null,
    severity: "warn",
    filePath: null,
    lineNumber: null,
    description,
    suggestion: null,
    mediaRef: null,
    status: "open",
    createdAt: "2026-07-20T10:00:00.000Z",
  };
}

function makeMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: "msg_1",
    senderAgentId: AGENT_ID,
    recipientAgentId: "agt_other",
    senderName: "history-agent",
    recipientName: "Helper",
    content: "hello from history",
    delivered: true,
    readAt: "2026-07-20T10:00:05.000Z",
    createdAt: "2026-07-20T10:00:00.000Z",
    ...overrides,
  };
}

function renderTabs(
  overrides: Partial<React.ComponentProps<typeof DetailTabs>> = {}
) {
  const media = overrides.media ?? [];
  apiMock.mockImplementation(async (requestPath: string) => {
    const mediaId = Number(requestPath.split("/").pop());
    const item = media.find((candidate) => candidate.id === mediaId);
    if (!item) throw new Error("Media item not found");
    return {
      media: {
        id: item.id,
        ownerAgentId: AGENT_ID,
        name: item.file_name,
        source: item.source,
        size: item.size_bytes,
        updatedAt: item.created_at,
        description: item.description,
        url: `/api/v1/agents/${AGENT_ID}/media/${encodeURIComponent(item.file_name)}`,
      },
    };
  });
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <DetailTabs
        events={[]}
        media={[]}
        pins={[]}
        feedback={[]}
        messages={[]}
        agentId={AGENT_ID}
        workspaceRoot="/repo"
        {...overrides}
      />
    </QueryClientProvider>
  );
}

function tabButton(label: string): HTMLElement {
  const button = screen
    .getAllByRole("button")
    .find((b) => b.textContent?.startsWith(label));
  if (!button) throw new Error(`No tab button labeled ${label}`);
  return button;
}

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

describe("DetailTabs", () => {
  it("defaults to the events tab and shows the empty state", () => {
    renderTabs();
    expect(screen.getByText("No events recorded.")).toBeTruthy();
    expect(screen.queryByText("No media captured.")).toBeNull();
  });

  it("shows a count badge only for non-empty collections", () => {
    renderTabs({ events: [makeEvent(1, "first"), makeEvent(2, "second")] });
    expect(tabButton("Events").textContent).toBe("Events2");
    // Empty tabs must not render a stray "0" badge.
    expect(tabButton("Media").textContent).toBe("Media");
    expect(tabButton("Pins").textContent).toBe("Pins");
    expect(tabButton("Feedback").textContent).toBe("Feedback");
    expect(tabButton("Messages").textContent).toBe("Messages");
  });

  it("renders the event timeline when events exist", () => {
    renderTabs({ events: [makeEvent(1, "compiled the plan")] });
    expect(screen.getByText("compiled the plan")).toBeTruthy();
  });

  it("switches panes per tab and shows each tab's empty state", () => {
    renderTabs({ events: [makeEvent(1, "only event")] });

    fireEvent.click(tabButton("Media"));
    expect(screen.getByText("No media captured.")).toBeTruthy();
    expect(screen.queryByText("only event")).toBeNull();

    fireEvent.click(tabButton("Pins"));
    expect(screen.getByText("No pins recorded.")).toBeTruthy();

    fireEvent.click(tabButton("Feedback"));
    expect(screen.getByText("No feedback received.")).toBeTruthy();

    fireEvent.click(tabButton("Messages"));
    expect(screen.getByText("No messages recorded.")).toBeTruthy();

    fireEvent.click(tabButton("Events"));
    expect(screen.getByText("only event")).toBeTruthy();
  });

  it("renders pins through PinItem with the workspace root", () => {
    const pins: AgentPin[] = [
      { label: "Preview URL", value: "http://localhost:3000", type: "url" },
      { label: "Branch", value: "feat/history", type: "string" },
    ];
    renderTabs({ pins });
    fireEvent.click(tabButton("Pins"));
    const items = screen.getAllByTestId("pin-item");
    expect(items).toHaveLength(2);
    expect(items[0]?.getAttribute("data-pin-label")).toBe("Preview URL");
    expect(items[1]?.getAttribute("data-pin-label")).toBe("Branch");
  });

  it("renders feedback items on the feedback tab", () => {
    renderTabs({ feedback: [makeFeedback(1, "Button label is misaligned")] });
    fireEvent.click(tabButton("Feedback"));
    expect(screen.getByText("Button label is misaligned")).toBeTruthy();
  });

  it("renders message threads on the messages tab", () => {
    renderTabs({ messages: [makeMessage()] });
    fireEvent.click(tabButton("Messages"));
    // Thread header is the OTHER participant (recipient of a sent message).
    expect(screen.getByText("Helper")).toBeTruthy();
    expect(screen.getByText("hello from history")).toBeTruthy();
  });

  it("renders screenshot tiles as images with encoded media URLs and text tiles as placeholders", () => {
    renderTabs({
      media: [
        makeMedia({
          id: 1,
          file_name: "my shot-2026-07-20-10-00-00-111.png",
          description: "Login page",
        }),
        makeMedia({
          id: 2,
          file_name: "capture-2026-07-20-10-00-00-222.mp4",
          source: "stream",
          description: null,
        }),
        makeMedia({
          id: 3,
          file_name: "sim-2026-07-20-10-00-00-333.png",
          source: "simulator",
          description: "Simulator frame",
        }),
      ],
    });
    fireEvent.click(tabButton("Media"));

    const img = screen.getByAltText("Login page");
    expect(img.getAttribute("src")).toBe(
      `/api/v1/agents/${AGENT_ID}/media/my%20shot-2026-07-20-10-00-00-111.png`
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
      media: [
        makeMedia({
          id: 1,
          file_name: "first-2026-07-20-10-00-00-111.png",
          description: "First shot",
        }),
        makeMedia({
          id: 2,
          file_name: "second-2026-07-20-10-00-00-222.png",
          description: null,
        }),
        makeMedia({
          id: 3,
          file_name: "third-2026-07-20-10-00-00-333.png",
          description: "Third shot",
        }),
      ],
    });
    fireEvent.click(tabButton("Media"));
    expect(screen.queryByTestId("media-lightbox")).toBeNull();

    // Second tile has no description, so its alt falls back to the file name.
    fireEvent.click(
      screen
        .getByAltText("second-2026-07-20-10-00-00-222.png")
        .closest("button")!
    );

    expect(screen.queryByText("Loading media…")).toBeNull();
    await screen.findByText("second.png");
    const lightbox = within(screen.getByTestId("media-lightbox"));
    expect(apiMock).toHaveBeenCalledWith("/api/v1/media/2");
    // Caption falls back to the timestamp-stripped file name.
    expect(lightbox.getByText("second.png")).toBeTruthy();
    // Index and count both reached the lightbox.
    expect(lightbox.getByText("2/3")).toBeTruthy();

    // ArrowRight advances to the third item, proving index wiring is live
    // state (not a snapshot) and totalItems permits forward navigation.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    const thirdLightbox = within(screen.getByTestId("media-lightbox"));
    await thirdLightbox.findByText("Third shot");
    expect(thirdLightbox.getByText("3/3")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("media-lightbox")).toBeNull();
  });
});
