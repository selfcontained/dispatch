// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";
import { chatDraftAtomFamily } from "@/lib/store";

import { AgentPane, AgentViewToggle } from "./agent-pane";

// The chat pane's data layer is covered in chat-pane.test; here it is inert
// so the pane's hosting decisions — what is mounted, hidden, active — can
// be read straight off the DOM.
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

function agentNamed(id: string): Agent {
  return {
    id,
    name: `agent ${id}`,
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

function renderPane(overrides: Partial<PaneProps> = {}) {
  const props = paneProps(overrides);
  const view = render(<AgentPane {...props} />, { wrapper });
  return { ...view, props };
}

function isHidden(el: HTMLElement): boolean {
  return el.classList.contains("hidden");
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

describe("AgentViewToggle", () => {
  it("presses the current view and reports a pick of the other", () => {
    const onViewChange = vi.fn();
    render(<AgentViewToggle view="chat" onViewChange={onViewChange} />);
    const chat = screen.getByTestId("agent-view-chat");
    const console = screen.getByTestId("agent-view-console");
    expect(chat.getAttribute("data-state")).toBe("on");
    expect(console.getAttribute("data-state")).toBe("off");
    expect(
      screen.getByTestId("agent-view-toggle").getAttribute("data-view")
    ).toBe("chat");

    fireEvent.click(console);
    expect(onViewChange).toHaveBeenCalledWith("console");
    // Pressing the active segment again is not a change.
    fireEvent.click(chat);
    expect(onViewChange).toHaveBeenCalledTimes(1);
  });

  it("carries the unread count on the Chat segment only while Console is up", () => {
    const first = render(
      <AgentViewToggle
        view="console"
        onViewChange={vi.fn()}
        chatUnreadCount={4}
      />
    );
    expect(screen.getByTestId("agent-view-chat-unread").textContent).toBe("4");
    first.unmount();

    render(
      <AgentViewToggle view="chat" onViewChange={vi.fn()} chatUnreadCount={4} />
    );
    expect(screen.queryByTestId("agent-view-chat-unread")).toBeNull();
  });

  it("slides one compact indicator between views", () => {
    const view = render(<AgentViewToggle view="chat" onViewChange={vi.fn()} />);
    const toggle = screen.getByTestId("agent-view-toggle");
    const track = screen.getByTestId("agent-view-track");
    const indicator = screen.getByTestId("agent-view-indicator");
    expect(toggle.className).toContain("h-6");
    expect(toggle.className).toContain("w-[9.5rem]");
    expect(toggle.className).toContain("pointer-coarse:h-11");
    expect(track.className).toContain("h-6");
    expect(indicator.className).toContain("transition-transform");
    expect(indicator.className).not.toContain(
      "translate-x-[calc(100%+0.25rem)]"
    );

    view.rerender(<AgentViewToggle view="console" onViewChange={vi.fn()} />);
    expect(indicator.className).toContain("translate-x-[calc(100%+0.25rem)]");
  });

  it("keeps the segment icons at full size instead of squeezing them", () => {
    // The labels and icons share a flex row: without shrink-0 the longer
    // "Console" label squashes its terminal glyph to a sliver rather than
    // letting the segment be the thing that gives.
    render(<AgentViewToggle view="chat" onViewChange={vi.fn()} />);
    for (const id of ["agent-view-chat", "agent-view-console"]) {
      const icon = screen.getByTestId(id).querySelector("svg");
      expect(icon?.getAttribute("class")).toContain("shrink-0");
    }
  });

  it("opens chat filters and reports child-agent visibility changes", () => {
    const onShowChildAgentsChange = vi.fn();
    const view = render(
      <AgentViewToggle
        view="chat"
        onViewChange={vi.fn()}
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
      <AgentViewToggle
        view="chat"
        onViewChange={vi.fn()}
        showChildAgents={false}
        onShowChildAgentsChange={onShowChildAgentsChange}
      />
    );
    expect(
      screen.getByTestId("chat-filters-trigger").getAttribute("aria-label")
    ).toBe("Chat filters, child-agent messages hidden");
  });

  it("keeps the filter icon unchanged inside a compact visible surface", () => {
    render(<AgentViewToggle view="chat" onViewChange={vi.fn()} />);
    const trigger = screen.getByTestId("chat-filters-trigger");
    const surface = screen.getByTestId("chat-filters-surface");
    const icon = screen.getByTestId("chat-filters-icon");

    expect(trigger.className).toContain("pointer-coarse:h-11");
    expect(trigger.className).toContain("hover:bg-transparent");
    expect(surface.className).toContain("h-6");
    expect(surface.className).toContain("w-6");
    expect(icon.getAttribute("class")).toContain("h-3.5");
    expect(icon.getAttribute("class")).toContain("w-3.5");
  });

  it("keeps the complete control group from shrinking under header pressure", () => {
    render(<AgentViewToggle view="chat" onViewChange={vi.fn()} />);
    const controls = screen.getByTestId("agent-view-toggle").parentElement;

    expect(controls?.className).toContain("shrink-0");
    expect(controls?.className).not.toContain("min-w-0");
  });
});

describe("AgentPane", () => {
  it("shows Chat over a hidden, still-mounted Console slot by default", () => {
    const { props } = renderPane();
    expect(screen.getByTestId("agent-pane").getAttribute("data-view")).toBe(
      "chat"
    );
    expect(screen.getByTestId("chat-pane")).toBeTruthy();
    expect(isHidden(screen.getByTestId("agent-pane-chat"))).toBe(false);
    const console = screen.getByTestId("agent-pane-console");
    expect(isHidden(console)).toBe(true);
    // The slot is handed to the layout hook so the terminal can be parented.
    expect(props.terminalSlotRef.current).toBe(console);
    // Header: agent name and the toggle.
    expect(screen.getByText("agent agt_a")).toBeTruthy();
    expect(screen.getByTestId("agent-view-toggle")).toBeTruthy();
  });

  it("hides Chat with CSS while Console is up, keeping the composer mounted", () => {
    renderPane({ view: "console" });
    expect(isHidden(screen.getByTestId("agent-pane-chat"))).toBe(true);
    expect(isHidden(screen.getByTestId("agent-pane-console"))).toBe(false);
    expect(screen.getByTestId("chat-composer-input")).toBeTruthy();
  });

  it("is the bare terminal slot with the chat surface off", () => {
    const { props } = renderPane({ chatEnabled: false, view: "console" });
    expect(screen.queryByTestId("agent-view-toggle")).toBeNull();
    expect(screen.queryByTestId("chat-pane")).toBeNull();
    expect(screen.queryByTestId("agent-pane-chat")).toBeNull();
    expect(
      screen.getByTestId("agent-pane").getAttribute("data-view")
    ).toBeNull();
    const console = screen.getByTestId("agent-pane-console");
    expect(isHidden(console)).toBe(false);
    expect(props.terminalSlotRef.current).toBe(console);
  });

  it("leaves the header to the split pane when asked", () => {
    renderPane({ header: false });
    expect(screen.queryByTestId("agent-view-toggle")).toBeNull();
    expect(screen.queryByText("agent agt_a")).toBeNull();
    expect(screen.getByTestId("chat-pane")).toBeTruthy();
  });

  it("keeps an unsent draft — text, link and file — across a Chat → Console → Chat round trip", () => {
    const { rerender, props } = renderPane();
    const input = screen.getByTestId(
      "chat-composer-input"
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "half typed" } });
    fireEvent.paste(input, {
      clipboardData: { items: [], getData: () => "https://example.com/x" },
    });
    fireEvent.paste(input, {
      clipboardData: {
        items: [
          {
            kind: "file",
            getAsFile: () =>
              new File(["png"], "shot.png", { type: "image/png" }),
          },
        ],
        getData: () => "",
      },
    });
    expect(screen.getByTestId("context-file-item")).toBeTruthy();

    rerender(<AgentPane {...props} view="console" />);
    expect(isHidden(screen.getByTestId("agent-pane-chat"))).toBe(true);

    rerender(<AgentPane {...props} view="chat" />);
    const again = screen.getByTestId(
      "chat-composer-input"
    ) as HTMLTextAreaElement;
    expect(again).toBe(input);
    expect(again.value).toBe("half typed");
    expect(screen.getByTestId("context-link-item").getAttribute("title")).toBe(
      "https://example.com/x"
    );
    // The live File survives too — no placeholder, still sendable.
    expect(screen.getByTestId("context-file-item")).toBeTruthy();
    expect(screen.queryByTestId("chat-attachment-chip-placeholder")).toBeNull();
    expect(
      (screen.getByTestId("chat-composer-send") as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it("remounts the chat pane per agent", () => {
    const { rerender, props } = renderPane();
    const first = screen.getByTestId("chat-pane");
    rerender(
      <AgentPane {...props} agentId="agt_b" agent={agentNamed("agt_b")} />
    );
    expect(screen.getByTestId("chat-pane")).not.toBe(first);
  });

  it("reports the chat pane inactive while Console is up", () => {
    // The composer only takes focus while the chat is the visible view.
    renderPane({ view: "console", active: true });
    expect(document.activeElement).not.toBe(
      screen.getByTestId("chat-composer-input")
    );
  });
});
