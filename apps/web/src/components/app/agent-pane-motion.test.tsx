// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { createRef, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";
import { chatDraftAtomFamily } from "@/lib/store";

import { AgentPane } from "./agent-pane";

// Deliberately NOT mocking framer-motion: this file is about what the motion
// layer actually writes to the DOM. agent-pane.test.tsx stubs the animation
// away to assert the pane's hosting decisions; the two are complementary and
// the bug this file guards — a Console layer with no managed styles staying
// painted under a Chat toggle — is invisible with the stub in place.
vi.mock("@/hooks/use-chat", () => ({
  useChatFeed: () => ({
    entries: [],
    unreadCount: 0,
    hasOlder: false,
    isLoading: false,
    isFetchingOlder: false,
    error: null,
    loadOlder: vi.fn(),
    refetch: vi.fn(),
  }),
  useSendChatMessage: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    variables: undefined,
  }),
  useAnswerChatQuestion: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    variables: undefined,
  }),
  useMarkChatRead: () => vi.fn(),
}));
vi.mock("@/hooks/use-injection-hold-state", () => ({
  useInjectionHoldState: () => null,
}));
vi.mock("@/components/ui/markdown-mermaid", () => ({
  MermaidBlock: () => null,
}));
vi.mock("@/components/ui/markdown-mermaid-theme", () => ({
  useMermaidTheme: () => "default",
}));

const agent: Agent = {
  id: "agt_a",
  name: "agent agt_a",
  status: "running",
  cwd: "/tmp",
  worktreePath: null,
  worktreeBranch: null,
  tmuxSession: null,
  agentArgs: [],
  model: null,
  fullAccess: false,
  mediaDir: null,
  createdAt: "2026-09-02T09:00:00.000Z",
  updatedAt: "2026-09-02T10:00:00.000Z",
};

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
    agent,
    terminalMode: "tmux",
    active: true,
    chatEnabled: true,
    view: "chat",
    onViewChange: vi.fn(),
    chatUnreadCount: 0,
    showChildAgents: true,
    onShowChildAgentsChange: vi.fn(),
    childAgentIds: [],
    terminalSlotRef: createRef<HTMLDivElement>(),
    header: true,
    openLightbox: vi.fn(),
    isMobile: false,
    ...overrides,
  };
}

function styleOf(testId: string): { opacity: string; visibility: string } {
  const el = screen.getByTestId(testId) as HTMLElement;
  return { opacity: el.style.opacity, visibility: el.style.visibility };
}

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn();
  window.localStorage.clear();
  chatDraftAtomFamily.remove("agt_a");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgentPane motion layers", () => {
  it("gives every layer managed styles from its first mount", () => {
    render(<AgentPane {...paneProps({ view: "console" })} />, { wrapper });

    // A layer framer was never handed a target for is the failure mode: it
    // keeps its CSS default — opaque and visible — whatever the view says,
    // which is how the Console ended up painted under a Chat toggle.
    expect(styleOf("agent-pane-console")).toEqual({
      opacity: "1",
      visibility: "visible",
    });
    expect(styleOf("agent-pane-chat")).toEqual({
      opacity: "0",
      visibility: "hidden",
    });
  });

  it("manages the Console layer even before the chat surface resolves", () => {
    // First paint has the flag unresolved (`chatEnabled: false`). The layer
    // still has to carry a target — handing framer `undefined` here is what
    // left it with no baseline, so the first flip after the flag landed
    // snapped instead of fading. Full opacity is correct in this mode; the
    // point is that framer owns the value.
    render(<AgentPane {...paneProps({ chatEnabled: false, view: "chat" })} />, {
      wrapper,
    });
    expect(styleOf("agent-pane-console")).toEqual({
      opacity: "1",
      visibility: "visible",
    });
  });

  it("keeps the terminal slot from widening its grid track", () => {
    // jsdom does not lay out, so the class is the guard here; the behaviour
    // itself is pinned in e2e/chat-surface.spec.ts, which puts a 2000px child
    // in the slot on a 390px phone and fails without these two.
    render(<AgentPane {...paneProps({ view: "console" })} />, { wrapper });
    const slot = screen.getByTestId("agent-pane-terminal-slot");
    expect(slot.className).toContain("min-w-0");
    expect(slot.className).toContain("overflow-hidden");
  });
});
