// @vitest-environment jsdom
import type { StreamThreadResponse } from "@dispatch/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { threadQueryKey } from "@/hooks/use-stream";
import type { Block } from "@dispatch/shared";
import {
  block,
  findingBlock,
  findingRecord,
  questionBody,
  reviewBlock,
} from "@/test-utils/blocks";

import { DrawerContent } from "./drawer";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/components/ui/markdown", () => ({
  Markdown: ({ children }: { children: string }) => (
    <div data-testid="markdown-mock">{children}</div>
  ),
}));
vi.mock("@/components/ui/markdown-mermaid", () => ({
  MermaidBlock: () => null,
}));
vi.mock("@/components/ui/markdown-mermaid-theme", () => ({
  useMermaidTheme: () => "default",
}));
vi.mock("@/components/app/files-content", () => ({
  FilesContent: () => <div data-testid="stub-FilesContent" />,
}));
vi.mock("framer-motion", async (importOriginal) => {
  const { createFramerMotionMock } =
    await import("@/test-utils/framer-motion-mock");
  return createFramerMotionMock(importOriginal);
});

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  ResizeObserverStub;

const finding = (
  id: string,
  title: string,
  extra: Parameters<typeof findingBlock>[2] = {}
) =>
  findingBlock(
    id,
    { severity: "major", title, body: "Guard it." },
    {
      reviewId: "rv",
      author: { kind: "agent", agentId: "agt_rev" },
      toAgentId: "agt_1",
      ...extra,
    }
  );

// A review with one unseen comment on its first finding.
const review = reviewBlock({
  id: "rv",
  author: { kind: "agent", agentId: "agt_rev" },
  toAgentId: "agt_1",
  summary: "Two things.",
  findings: [
    finding("f1", "Null deref", { replyCount: 1, unreadReplies: 1 }),
    finding("f2", "Typo"),
  ],
});

const thread: StreamThreadResponse = { root: review, replies: [] };

let client: QueryClient;

function LocationProbe() {
  return <div data-testid="location-search">{useLocation().search}</div>;
}

function renderDrawer(
  search: string,
  {
    reviews = [review],
    inputs = [],
    onOpenBlock = vi.fn(),
  }: {
    reviews?: Block[];
    inputs?: Block[];
    onOpenBlock?: (id: string) => void;
  } = {}
) {
  const onRequestClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/agents/agt_1${search}`]}>
        <DrawerContent
          files={[]}
          selectedAgentId="agt_1"
          selectedAgentName="builder"
          animatingFileKeys={new Set()}
          drawerViewportRef={{ current: null }}
          openLightbox={vi.fn()}
          hasStream={false}
          streamUrl={null}
          unseenFileCount={0}
          activeTab="inbox"
          setActiveTab={vi.fn()}
          onRequestClose={onRequestClose}
          inbox={{
            rootId: "agt_1",
            inputs: inputs as never,
            links: [],
            reviews: reviews as never,
            isLoading: false,
          }}
          inboxDisabledReason={null}
          agentNameById={(id) => (id === "agt_rev" ? "reviewer" : "Agent")}
          onOpenBlock={onOpenBlock}
        />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { onRequestClose };
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(threadQueryKey("agt_1", "rv"), thread);
  apiMock.mockReset();
  apiMock.mockImplementation(async (url: string) =>
    url.endsWith("/thread") ? thread : { ids: [], readAt: null }
  );
  Element.prototype.scrollTo = vi.fn();
});

afterEach(cleanup);

describe("DrawerContent as the sidebar", () => {
  it("shows the home tabs with the review in the Inbox, and its unseen comments", () => {
    renderDrawer("");
    expect(screen.getByTestId("sidebar-tab-inbox")).toBeTruthy();
    // A thread is the thread drawer's, never a page over the sidebar.
    expect(screen.queryByTestId("drawer-back")).toBeNull();
    const card = screen.getByTestId("inbox-review");
    expect(card.textContent).toContain("reviewer");
    // One badge, derived from the findings: one is open.
    const status = screen.getByTestId("inbox-review-status");
    expect(status.textContent).toBe("Changes requested");
    expect(card.getAttribute("data-status")).toBe("open");
    expect(screen.queryByTestId("inbox-review-verdict")).toBeNull();
    expect(card.textContent).toContain("2 findings · 2 open");
    // Unseen comments are counted off the findings' own threads.
    expect(screen.getByTestId("inbox-review-unread").textContent).toBe("1");
  });

  it("reads a review whose findings are all resolved as approved, and opens it", () => {
    const onOpenBlock = vi.fn();
    const settled = reviewBlock({
      id: "rv",
      author: { kind: "agent", agentId: "agt_rev" },
      toAgentId: "agt_1",
      findings: [
        finding("f1", "Null deref", { record: findingRecord("fixed") }),
        finding("f2", "Typo", { record: findingRecord("dismissed") }),
      ],
    });
    renderDrawer("", { reviews: [settled], onOpenBlock });
    const card = screen.getByTestId("inbox-review");
    expect(card.getAttribute("data-status")).toBe("resolved");
    expect(screen.getByTestId("inbox-review-status").textContent).toBe(
      "Approved"
    );
    expect(screen.queryByTestId("inbox-review-unread")).toBeNull();
    fireEvent.click(card);
    expect(onOpenBlock).toHaveBeenCalledWith("rv");
  });

  it("opens a review posted on a launch card, and an ask made in a thread, where they are", () => {
    const onOpenBlock = vi.fn();
    const onCard = reviewBlock({
      id: "rv-card",
      author: { kind: "agent", agentId: "agt_rev" },
      toAgentId: "agt_1",
      threadId: "card",
      replyTo: "card",
      findings: [finding("f9", "Leak")],
    });
    const ask = block({
      id: "q1",
      author: { kind: "agent", agentId: "agt_rev" },
      threadId: "card",
      replyTo: "card",
      text: "Which one?",
      body: questionBody([{ label: "A" }]),
    });
    renderDrawer("", { reviews: [onCard], inputs: [ask], onOpenBlock });
    fireEvent.click(screen.getByTestId("inbox-review"));
    expect(onOpenBlock).toHaveBeenLastCalledWith("card");
    fireEvent.click(screen.getByTestId("inbox-input-open"));
    expect(onOpenBlock).toHaveBeenLastCalledWith("card");
  });

  it("keeps its home even when the URL names a thread", () => {
    renderDrawer("?thread=rv&finding=f1");
    expect(screen.getByTestId("sidebar-tab-inbox")).toBeTruthy();
    expect(screen.queryByTestId("drawer-page")).toBeNull();
    expect(screen.queryByTestId("drawer-title")).toBeNull();
  });
});
