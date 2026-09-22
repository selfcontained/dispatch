// @vitest-environment jsdom
import type { StreamThreadResponse } from "@dispatch/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { threadQueryKey } from "@/hooks/use-stream";
import { block, reviewBody } from "@/test-utils/blocks";

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

const review = block({
  id: "rv",
  author: { kind: "agent", agentId: "agt_rev" },
  toAgentId: "agt_1",
  replyCount: 1,
  body: reviewBody("request_changes", "Two things.", [
    { id: "f1", severity: "major", title: "Null deref", body: "Guard it." },
    { id: "f2", severity: "nit", title: "Typo", body: "Fix it." },
  ]),
});

const thread: StreamThreadResponse = {
  root: review,
  replies: [
    block({
      id: "c1",
      author: { kind: "agent", agentId: "agt_rev" },
      text: "Still spins.",
      threadId: "rv",
      replyTo: "rv",
      body: { kind: "text", data: { findingId: "f1" }, state: null },
    }),
  ],
};

let client: QueryClient;

function LocationProbe() {
  return <div data-testid="location-search">{useLocation().search}</div>;
}

function renderDrawer(search: string) {
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
            inputs: [],
            links: [],
            reviews: [review as never],
            isLoading: false,
          }}
          inboxDisabledReason={null}
          agentNameById={(id) => (id === "agt_rev" ? "reviewer" : "Agent")}
          onOpenBlock={vi.fn()}
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
    expect(screen.getByTestId("inbox-review-status").textContent).toBe("Open");
    expect(screen.getByTestId("inbox-review-unread").textContent).toBe("1");
  });

  it("keeps its home even when the URL names a thread", () => {
    renderDrawer("?thread=rv&finding=f1");
    expect(screen.getByTestId("sidebar-tab-inbox")).toBeTruthy();
    expect(screen.queryByTestId("drawer-page")).toBeNull();
    expect(screen.queryByTestId("drawer-title")).toBeNull();
  });
});
