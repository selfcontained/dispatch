// @vitest-environment jsdom
import type { StreamThreadResponse } from "@dispatch/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
          activeTab="rail"
          setActiveTab={vi.fn()}
          onRequestClose={onRequestClose}
          rail={{
            rootId: "agt_1",
            inputs: [],
            links: [],
            reviews: [review as never],
            isLoading: false,
          }}
          railDisabledReason={null}
          agentNameById={(id) => (id === "agt_rev" ? "reviewer" : "Agent")}
          agent={
            {
              id: "agt_1",
              name: "builder",
              status: "running",
              type: "claude",
            } as never
          }
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

describe("DrawerContent as the drawer", () => {
  it("shows the home tabs with the review in the rail, and its unseen comments", () => {
    renderDrawer("");
    expect(screen.getByTestId("drawer").getAttribute("data-depth")).toBe("0");
    expect(screen.getByTestId("sidebar-tab-rail")).toBeTruthy();
    expect(screen.queryByTestId("drawer-back")).toBeNull();
    const card = screen.getByTestId("rail-review");
    expect(card.textContent).toContain("reviewer");
    expect(screen.getByTestId("rail-review-status").textContent).toBe("Open");
    expect(screen.getByTestId("rail-review-unread").textContent).toBe("1");
  });

  it("stacks the review page and then the finding page from the URL, with a way back", async () => {
    renderDrawer("?thread=rv&finding=f1");
    expect(screen.getByTestId("drawer").getAttribute("data-depth")).toBe("2");
    const pages = screen.getAllByTestId("drawer-page");
    expect(pages.map((p) => p.getAttribute("data-page-key"))).toEqual([
      "home",
      "thread:rv",
      "finding:rv",
    ]);
    expect(screen.getByTestId("drawer-title").textContent).toBe("Finding");
    expect(screen.getByTestId("drawer-subtitle").textContent).toBe(
      "in the review by reviewer"
    );
    // The finding page is the top one: its detail, its own composer.
    expect(screen.getByTestId("chat-finding-detail").textContent).toContain(
      "Null deref"
    );
    // Opening the finding marks its comments seen.
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/v1/streams/agt_1/blocks/rv/read",
        { method: "POST", body: JSON.stringify({ finding: "f1" }) }
      )
    );

    fireEvent.click(screen.getByTestId("drawer-back"));
    expect(screen.getByTestId("location-search").textContent).toBe(
      "?thread=rv"
    );
    expect(screen.getByTestId("drawer-title").textContent).toBe("Review");
    expect(screen.getByTestId("drawer-subtitle").textContent).toBe(
      "by reviewer"
    );
    expect(screen.queryByTestId("chat-finding-detail")).toBeNull();
    expect(screen.getAllByTestId("chat-review-finding")).toHaveLength(2);

    fireEvent.click(screen.getByTestId("drawer-back"));
    expect(screen.getByTestId("location-search").textContent).toBe("");
    expect(screen.getByTestId("drawer").getAttribute("data-depth")).toBe("0");
  });

  it("opens a finding's page from a row on the review page", () => {
    renderDrawer("?thread=rv");
    fireEvent.click(screen.getAllByTestId("chat-review-finding-link")[1]!);
    expect(screen.getByTestId("location-search").textContent).toBe(
      "?thread=rv&finding=f2"
    );
    expect(screen.getByTestId("chat-finding-detail").textContent).toContain(
      "Typo"
    );
  });
});
