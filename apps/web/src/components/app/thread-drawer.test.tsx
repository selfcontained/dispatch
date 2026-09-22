// @vitest-environment jsdom
import type { StreamThreadResponse } from "@dispatch/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { threadQueryKey } from "@/hooks/use-stream";
import { block, reviewBody } from "@/test-utils/blocks";

import { DrawerFrame } from "./drawer";
import { ThreadDrawer } from "./thread-drawer";

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

const note = block({
  id: "n2",
  author: { kind: "agent", agentId: "agt_1" },
  text: "A second thread.",
});

let client: QueryClient;

function LocationProbe() {
  return <div data-testid="location-search">{useLocation().search}</div>;
}

function renderThreadDrawer(search: string) {
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/agents/agt_1${search}`]}>
        <ThreadDrawer
          selectedAgentId="agt_1"
          selectedAgentName="builder"
          rootId="agt_1"
          openLightbox={vi.fn()}
          agentNameById={(id) => (id === "agt_rev" ? "reviewer" : "Agent")}
          agent={
            {
              id: "agt_1",
              name: "builder",
              status: "running",
              type: "claude",
            } as never
          }
        />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const agentProp = {
  id: "agt_1",
  name: "builder",
  status: "running",
  type: "claude",
} as never;

/** The drawer as agents-view mounts it: in a frame open while the URL names a thread. */
function FramedThreadDrawer() {
  const search = useLocation().search;
  const navigate = useNavigate();
  return (
    <>
      <DrawerFrame
        open={new URLSearchParams(search).has("thread")}
        pinned
        testId="thread-drawer-wrapper"
      >
        <ThreadDrawer
          selectedAgentId="agt_1"
          selectedAgentName="builder"
          rootId="agt_1"
          openLightbox={vi.fn()}
          agentNameById={(id) => (id === "agt_rev" ? "reviewer" : "Agent")}
          agent={agentProp}
        />
      </DrawerFrame>
      <button data-testid="go-n2" onClick={() => navigate("?thread=n2")} />
      <button data-testid="go-rv" onClick={() => navigate("?thread=rv")} />
    </>
  );
}

function renderFramed(search: string) {
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/agents/agt_1${search}`]}>
        <FramedThreadDrawer />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function endSlide() {
  const wrapper = screen.getByTestId("thread-drawer-wrapper");
  const event = createEvent.transitionEnd(wrapper);
  Object.defineProperty(event, "propertyName", { value: "width" });
  fireEvent(wrapper, event);
}

const titleText = () => screen.getByTestId("drawer-title").textContent;

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(threadQueryKey("agt_1", "rv"), thread);
  client.setQueryData(threadQueryKey("agt_1", "n2"), {
    root: note,
    replies: [],
  } satisfies StreamThreadResponse);
  apiMock.mockReset();
  apiMock.mockImplementation(async (url: string) =>
    url.endsWith("/thread") ? thread : { ids: [], readAt: null }
  );
  Element.prototype.scrollTo = vi.fn();
});

afterEach(cleanup);

describe("ThreadDrawer", () => {
  it("is nothing when the URL names no thread", () => {
    renderThreadDrawer("");
    expect(screen.queryByTestId("thread-drawer")).toBeNull();
  });

  it("stacks the finding page over the review page from the URL: back to the review, then close", async () => {
    renderThreadDrawer("?thread=rv&finding=f1");
    const drawer = screen.getByTestId("thread-drawer");
    expect(drawer.getAttribute("data-depth")).toBe("2");
    const pages = screen.getAllByTestId("drawer-page");
    expect(pages.map((p) => p.getAttribute("data-page-key"))).toEqual([
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
    expect(screen.getByTestId("thread-drawer").getAttribute("data-depth")).toBe(
      "1"
    );
    expect(screen.getByTestId("drawer-title").textContent).toBe("Review");
    expect(screen.getByTestId("drawer-subtitle").textContent).toBe(
      "by reviewer"
    );
    expect(screen.queryByTestId("chat-finding-detail")).toBeNull();
    expect(screen.getAllByTestId("chat-review-finding")).toHaveLength(2);
    // At the review there is nowhere back to: the one way out is close.
    expect(screen.queryByTestId("drawer-back")).toBeNull();

    fireEvent.click(screen.getByTestId("drawer-close"));
    expect(screen.getByTestId("location-search").textContent).toBe("");
    expect(screen.queryByTestId("thread-drawer")).toBeNull();
  });

  it("closes from the finding page in one go", () => {
    renderThreadDrawer("?thread=rv&finding=f1");
    fireEvent.click(screen.getByTestId("drawer-close"));
    expect(screen.getByTestId("location-search").textContent).toBe("");
    expect(screen.queryByTestId("thread-drawer")).toBeNull();
  });

  it("opens a finding's page from a row on the review page", () => {
    renderThreadDrawer("?thread=rv");
    fireEvent.click(screen.getAllByTestId("chat-review-finding-link")[1]!);
    expect(screen.getByTestId("location-search").textContent).toBe(
      "?thread=rv&finding=f2"
    );
    expect(screen.getByTestId("chat-finding-detail").textContent).toContain(
      "Typo"
    );
  });
});

describe("ThreadDrawer closing in its frame", () => {
  it("stays mounted with the closed thread's content until the slide ends", () => {
    renderFramed("?thread=rv&finding=f1");
    fireEvent.click(screen.getByTestId("drawer-close"));
    expect(screen.getByTestId("location-search").textContent).toBe("");

    const wrapper = screen.getByTestId("thread-drawer-wrapper");
    expect(wrapper.style.width).toBe("0px");
    expect(wrapper.dataset.closing).toBe("true");
    // Still the finding it was showing, not an empty box.
    expect(screen.getByTestId("thread-drawer").getAttribute("data-depth")).toBe(
      "2"
    );
    expect(screen.getByTestId("chat-finding-detail").textContent).toContain(
      "Null deref"
    );

    endSlide();
    expect(screen.queryByTestId("thread-drawer")).toBeNull();
  });

  it("switching straight to another thread shows it, not the one before", () => {
    renderFramed("?thread=rv");
    expect(titleText()).toBe("Review");
    fireEvent.click(screen.getByTestId("go-n2"));
    expect(screen.getAllByTestId("drawer-page")[0]!.dataset.pageKey).toBe(
      "thread:n2"
    );
    expect(screen.queryByTestId("chat-review-finding")).toBeNull();
  });

  it("opening another thread mid-close shows the new one at once, and closing it holds that one", () => {
    renderFramed("?thread=rv");
    fireEvent.click(screen.getByTestId("drawer-close"));
    expect(titleText()).toBe("Review");

    fireEvent.click(screen.getByTestId("go-n2"));
    const wrapper = screen.getByTestId("thread-drawer-wrapper");
    expect(wrapper.dataset.closing).toBeUndefined();
    expect(wrapper.style.width).not.toBe("0px");
    expect(screen.getAllByTestId("drawer-page")[0]!.dataset.pageKey).toBe(
      "thread:n2"
    );
    // The close that was cut short ends as this open's slide; nothing unmounts.
    endSlide();
    expect(screen.getByTestId("thread-drawer")).toBeTruthy();

    fireEvent.click(screen.getByTestId("drawer-close"));
    expect(screen.getAllByTestId("drawer-page")[0]!.dataset.pageKey).toBe(
      "thread:n2"
    );
    endSlide();
    expect(screen.queryByTestId("thread-drawer")).toBeNull();
  });

  it("closing and reopening the same thread neither races nor sticks", () => {
    renderFramed("?thread=rv");
    fireEvent.click(screen.getByTestId("drawer-close"));
    fireEvent.click(screen.getByTestId("go-rv"));
    const wrapper = screen.getByTestId("thread-drawer-wrapper");
    expect(wrapper.dataset.closing).toBeUndefined();
    endSlide();
    expect(titleText()).toBe("Review");
    expect(wrapper.style.width).not.toBe("0px");
  });
});
