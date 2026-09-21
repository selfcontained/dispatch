// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";
import { chatDraftAtomFamily } from "@/lib/store";

import { AgentPane, ChatFiltersButton } from "./agent-pane";

// Strip the animation layer so the pane's own DOM is what the tests read.
vi.mock("framer-motion", async (importOriginal) => {
  const { createFramerMotionMock } =
    await import("@/test-utils/framer-motion-mock");
  return createFramerMotionMock(importOriginal);
});

// The chat pane's data layer is covered in chat-pane.test; here it is inert
// so the pane's hosting decisions — what is mounted, hidden, active — can
// be read straight off the DOM.
vi.mock("@/hooks/use-stream", () => ({
  useStreamFeed: () => ({
    entries: [],
    unreadCount: 0,
    hasOlder: false,
    isLoading: false,
    isFetchingOlder: false,
    error: null,
    loadOlder: vi.fn(),
    refetch: vi.fn(),
  }),
  usePostBlock: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    variables: undefined,
  }),
  useAnswerQuestion: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    variables: undefined,
  }),
  useSubmitForm: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    variables: undefined,
  }),
  useRetryDelivery: () => ({
    mutate: vi.fn(),
    isPending: false,
    variables: undefined,
  }),
  useSetBlockState: () => ({
    mutate: vi.fn(),
    isPending: false,
    variables: undefined,
  }),
  useMarkStreamRead: () => vi.fn(),
  // One mutate for the whole file: the feed's rows are memoised on a context
  // built from it.
  useToggleReaction: (() => {
    const mutate = vi.fn();
    return () => ({ mutate });
  })(),
}));
vi.mock("@/components/ui/markdown-mermaid", () => ({
  MermaidBlock: () => null,
}));
vi.mock("@/components/ui/markdown-mermaid-theme", () => ({
  useMermaidTheme: () => "default",
}));

function agentNamed(id: string): Agent {
  return {
    id,
    name: `agent ${id}`,
    status: "running",
    cwd: "/tmp",
    worktreePath: null,
    worktreeBranch: null,
    agentArgs: [],
    model: null,
    fullAccess: false,
    filesDir: null,
    createdAt: "2026-09-02T09:00:00.000Z",
    updatedAt: "2026-09-02T10:00:00.000Z",
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

type PaneProps = Parameters<typeof AgentPane>[0];

function paneProps(overrides: Partial<PaneProps> = {}): PaneProps {
  return {
    agentId: "agt_a",
    agent: agentNamed("agt_a"),
    active: true,
    showChildAgents: true,
    onShowChildAgentsChange: vi.fn(),
    header: true,
    openLightbox: vi.fn(),
    isMobile: false,
    ...overrides,
  };
}

function renderPane(overrides: Partial<PaneProps> = {}) {
  const props = paneProps(overrides);
  const view = render(<AgentPane {...props} />, { wrapper });
  return { ...view, props };
}

beforeEach(() => {
  // jsdom has no scrollTo; the chat pane pins the feed to the bottom with it.
  Element.prototype.scrollTo = vi.fn();
  window.localStorage.clear();
  chatDraftAtomFamily.remove("agt_a");
  chatDraftAtomFamily.remove("agt_b");
  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn(() => "blob:preview"),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
});

describe("ChatFiltersButton", () => {
  it("opens chat filters and reports child-agent visibility changes", () => {
    const onShowChildAgentsChange = vi.fn();
    const view = render(
      <ChatFiltersButton
        showChildAgents={true}
        onShowChildAgentsChange={onShowChildAgentsChange}
      />
    );

    fireEvent.click(screen.getByTestId("chat-filters-trigger"));
    expect(screen.getByTestId("chat-filters-popover")).toBeTruthy();
    const toggle = screen.getByTestId("show-child-agents-switch");
    expect(toggle.getAttribute("data-state")).toBe("checked");
    fireEvent.click(toggle);
    expect(onShowChildAgentsChange).toHaveBeenCalledWith(false);

    view.rerender(
      <ChatFiltersButton
        showChildAgents={false}
        onShowChildAgentsChange={onShowChildAgentsChange}
      />
    );
    expect(
      screen.getByTestId("chat-filters-trigger").getAttribute("aria-label")
    ).toBe("Chat filters, child agents hidden");
  });

  it("keeps the filter icon unchanged inside a compact visible surface", () => {
    render(<ChatFiltersButton />);
    const trigger = screen.getByTestId("chat-filters-trigger");
    const surface = screen.getByTestId("chat-filters-surface");
    const icon = screen.getByTestId("chat-filters-icon");

    expect(trigger.className).toContain("pointer-coarse:h-11");
    expect(trigger.className).toContain("shrink-0");
    expect(surface.className).toContain("h-6");
    expect(surface.className).toContain("w-6");
    expect(icon.getAttribute("class")).toContain("h-3.5");
  });
});

describe("AgentPane", () => {
  it("shows the agent's name, the filters and the chat pane", () => {
    renderPane();
    expect(screen.getByText("agent agt_a")).toBeTruthy();
    expect(screen.getByTestId("chat-filters-trigger")).toBeTruthy();
    expect(screen.getByTestId("chat-pane")).toBeTruthy();
    expect(screen.queryByTestId("agent-view-toggle")).toBeNull();
    expect(screen.queryByTestId("agent-pane-console")).toBeNull();
  });

  it("leaves the header to the split pane when asked", () => {
    renderPane({ header: false });
    expect(screen.queryByTestId("chat-filters-trigger")).toBeNull();
    expect(screen.queryByText("agent agt_a")).toBeNull();
    expect(screen.getByTestId("chat-pane")).toBeTruthy();
  });

  it("remounts the chat pane per agent", () => {
    const { rerender, props } = renderPane();
    const first = screen.getByTestId("chat-pane");
    rerender(
      <AgentPane {...props} agentId="agt_b" agent={agentNamed("agt_b")} />
    );
    expect(screen.getByTestId("chat-pane")).not.toBe(first);
  });

  it("does not take focus while the pane is inactive", () => {
    renderPane({ active: false });
    expect(document.activeElement).not.toBe(
      screen.getByTestId("chat-composer-input")
    );
  });
});
