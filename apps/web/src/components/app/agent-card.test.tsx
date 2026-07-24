// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";
import { TooltipProvider } from "@/components/ui/tooltip";

import { AgentCard, type AgentCardProps } from "./agent-card";

// The card renders its real header/status/details/actions children — the point
// of these tests is that the four-file split (#803) keeps passing each child
// the props it needs. Only the HTTP seam is mocked.
vi.mock("@/lib/api", () => ({ api: vi.fn() }));

// Animations are replaced with plain elements so collapse/expand is synchronous;
// otherwise AnimatePresence's exit animation leaves the old subtree mounted for
// an indeterminate number of frames and assertions race it.
vi.mock("framer-motion", async () => {
  const React = await import("react");
  const MOTION_ONLY_PROPS = new Set([
    "layout",
    "layoutId",
    "initial",
    "animate",
    "exit",
    "transition",
    "variants",
  ]);
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) =>
        React.forwardRef<HTMLElement, Record<string, unknown>>((props, ref) => {
          const domProps = Object.fromEntries(
            Object.entries(props).filter(([key]) => !MOTION_ONLY_PROPS.has(key))
          );
          return React.createElement(tag, { ...domProps, ref });
        }),
    }
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children?: ReactNode }) => children,
  };
});

const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);

const AGENT_ID = "agt_parent";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT_ID,
    name: "worker-1",
    type: "claude",
    status: "running",
    cwd: "/repo/app",
    worktreePath: null,
    worktreeBranch: null,
    tmuxSession: `dispatch-${AGENT_ID}`,
    agentArgs: [],
    fullAccess: false,
    mediaDir: null,
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
    ...overrides,
  };
}

function makeChild(overrides: Partial<Agent> = {}): Agent {
  return makeAgent({
    id: "agt_child",
    name: "security-review-abc123",
    persona: "security-review",
    parentAgentId: AGENT_ID,
    role: "review",
    tmuxSession: "dispatch-agt_child",
    ...overrides,
  });
}

function wrap(client: QueryClient, node: ReactElement): ReactElement {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>{node}</TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function baseProps(agent: Agent): AgentCardProps {
  return {
    agent,
    agents: [agent],
    childAgents: [],
    selectedAgentId: null,
    expandedAgentId: null,
    agentVisualState: (a) => (a.status === "stopped" ? "stopped" : "active"),
    borderForAgentState: (state) => `border-state-${state}`,
    toggleAgentDetails: vi.fn(),
    isFullAccessEnabled: (a) => a.fullAccess,
    detachTerminal: vi.fn(),
    attachToAgent: vi.fn().mockResolvedValue(undefined),
    startAgent: vi.fn().mockResolvedValue(undefined),
    openSubmittedReview: vi.fn(),
    setDeleteTarget: vi.fn(),
    setDeleteConfirmOpen: vi.fn(),
    setStopTarget: vi.fn(),
    setStopConfirmOpen: vi.fn(),
    enabledAgentTypes: ["claude", "codex", "terminal"],
    enabledIdes: ["vscode"],
  };
}

function renderCard(overrides: Partial<AgentCardProps> = {}) {
  const props: AgentCardProps = {
    ...baseProps(overrides.agent ?? makeAgent()),
    ...overrides,
  };
  // One client for the whole render+rerender cycle so a rerender doesn't drop
  // the query cache and refetch.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(wrap(client, <AgentCard {...props} />));
  return {
    props,
    rerender: (next: Partial<AgentCardProps> = {}) =>
      view.rerender(wrap(client, <AgentCard {...props} {...next} />)),
  };
}

function card(agentId = AGENT_ID): HTMLElement {
  return screen.getByTestId(`agent-card-${agentId}`);
}

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/v1/personas")) return { personas: [] };
    if (url.includes("/diff-stats")) return { diffStats: null };
    return {};
  });
  // jsdom implements none of these: DiffStatBadge reads matchMedia, the persona
  // launcher's cmdk list observes its own size and scrolls the active option
  // into view, and useCopyText prefers the Clipboard API.
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(cleanup);

describe("AgentCard state and selection", () => {
  it("neutralizes the parent's visual state and selection while a child is connected", () => {
    const child = makeChild();
    const { rerender } = renderCard({
      childAgents: [child],
      selectedAgentId: AGENT_ID,
      connectedAgentId: child.id,
    });

    // The parent is "active" and selected on paper, but the connected child owns
    // the terminal, so the card must not claim either.
    expect(card().className).toContain("border-state-idle");
    expect(card().className).not.toContain("border-state-active");
    expect(card().className).not.toContain("bg-muted/60");

    // Positive control: same props minus the connected child.
    rerender({ connectedAgentId: null });
    expect(card().className).toContain("border-state-active");
    expect(card().className).toContain("bg-muted/60");
  });

  it("dims stopped cards and offers resume instead of attaching on row click", () => {
    const { props } = renderCard({ agent: makeAgent({ status: "stopped" }) });

    expect(card().className).toContain("opacity-60");

    fireEvent.click(screen.getByTestId(`agent-session-name-${AGENT_ID}`));
    expect(props.attachToAgent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /resume/i }));
    expect(props.startAgent).toHaveBeenCalledWith(props.agent);
  });
});

describe("AgentCardHeader wiring", () => {
  it("attaches on row click, and detaches + collapses when already connected", () => {
    const { props, rerender } = renderCard();

    fireEvent.click(screen.getByTestId(`agent-session-name-${AGENT_ID}`));
    expect(props.attachToAgent).toHaveBeenCalledWith(props.agent);
    expect(props.detachTerminal).not.toHaveBeenCalled();

    rerender({ connectedAgentId: AGENT_ID, expandedAgentId: AGENT_ID });
    fireEvent.click(screen.getByTestId(`agent-session-name-${AGENT_ID}`));
    expect(props.detachTerminal).toHaveBeenCalledTimes(1);
    expect(props.toggleAgentDetails).toHaveBeenCalledWith(AGENT_ID);
    expect(props.attachToAgent).toHaveBeenCalledTimes(1);
  });

  it("does not attach when the click lands on a control inside the row", () => {
    const { props } = renderCard();

    fireEvent.click(screen.getByTestId(`agent-expand-toggle-${AGENT_ID}`));

    expect(props.toggleAgentDetails).toHaveBeenCalledWith(AGENT_ID);
    expect(props.attachToAgent).not.toHaveBeenCalled();
  });

  it("detaches a connected child when the card is collapsed", () => {
    const child = makeChild();
    const { props } = renderCard({
      childAgents: [child],
      expandedAgentId: AGENT_ID,
      connectedAgentId: child.id,
    });

    fireEvent.click(screen.getByTestId(`agent-expand-toggle-${AGENT_ID}`));

    expect(props.detachTerminal).toHaveBeenCalledTimes(1);
    expect(props.toggleAgentDetails).toHaveBeenCalledWith(AGENT_ID);
  });

  it("offers the rename prompt only for running, still-default session names", async () => {
    // id ends in "parent", so the server-assigned default name is agent-parent.
    renderCard({ agent: makeAgent({ name: "agent-parent" }) });

    const button = screen.getByTestId(`agent-prompt-rename-${AGENT_ID}`);
    fireEvent.click(button);

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        `/api/v1/agents/${AGENT_ID}/prompt-rename`,
        { method: "POST" }
      )
    );
    // Re-arming is delayed so a double click can't fire the prompt twice.
    expect(button).toHaveProperty("disabled", true);
  });

  // The `startsWith("job-")` guard in hasDefaultSessionName is unreachable — a
  // job- name can never equal the `agent-<id suffix>` default it also requires —
  // so there is no case for it here.
  it.each([
    ["a renamed session", makeAgent({ name: "fix-login-flow" })],
    ["a stopped agent", makeAgent({ name: "agent-parent", status: "stopped" })],
    [
      "a persona agent",
      makeAgent({ name: "agent-parent", persona: "security-review" }),
    ],
    ["a terminal agent", makeAgent({ name: "agent-parent", type: "terminal" })],
  ])("hides the rename prompt for %s", (_label, agent) => {
    renderCard({ agent });
    expect(screen.queryByTestId(`agent-prompt-rename-${AGENT_ID}`)).toBeNull();
  });

  it("badges agents that need attention, come from a job, or are updaters", () => {
    const { rerender } = renderCard({
      agent: makeAgent({ status: "error", lastError: "tmux session died" }),
    });
    expect(screen.getByText("Attention").getAttribute("title")).toBe(
      "tmux session died"
    );
    expect(screen.queryByText("Job")).toBeNull();

    rerender({ agent: makeAgent({ name: "job-nightly" }) });
    expect(screen.getByText("Job")).toBeTruthy();
    expect(screen.queryByText("Attention")).toBeNull();

    rerender({ agent: makeAgent({ role: "assisted_update" }) });
    expect(screen.getByText("Update")).toBeTruthy();
    expect(screen.queryByText("Job")).toBeNull();
  });
});

describe("AgentCardStatus wiring", () => {
  it("shows the setup phase while creating and the archive phase while archiving", () => {
    const { rerender } = renderCard({
      agent: makeAgent({ status: "creating", setupPhase: "deps" }),
    });
    expect(screen.getByText("Installing dependencies…")).toBeTruthy();

    // Unknown/absent phase still gets a generic line rather than nothing.
    rerender({ agent: makeAgent({ status: "creating", setupPhase: null }) });
    expect(screen.queryByText("Installing dependencies…")).toBeNull();

    rerender({
      agent: makeAgent({
        status: "archiving",
        archivePhase: "worktree-cleanup",
      }),
    });
    expect(screen.getByText("Removing worktree…")).toBeTruthy();

    rerender({ agent: makeAgent({ status: "running" }) });
    expect(screen.queryByText("Removing worktree…")).toBeNull();
    expect(screen.queryByText("Archiving…")).toBeNull();
  });

  it("shows the latest event for CLI agents and the message only when expanded", () => {
    const agent = makeAgent({
      latestEvent: {
        type: "blocked",
        message: "Waiting on a merge conflict",
        updatedAt: new Date().toISOString(),
      },
    });
    const { rerender } = renderCard({ agent });

    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(screen.queryByText("Waiting on a merge conflict")).toBeNull();

    rerender({ expandedAgentId: AGENT_ID });
    expect(screen.getByText("Waiting on a merge conflict")).toBeTruthy();
  });

  it("suppresses the latest-event line for terminal agents", () => {
    const latestEvent = {
      type: "working" as const,
      message: "Running tests",
      updatedAt: new Date().toISOString(),
    };
    const { rerender } = renderCard({
      agent: makeAgent({ type: "terminal", latestEvent }),
    });
    expect(screen.queryByText("Working")).toBeNull();

    rerender({ agent: makeAgent({ type: "claude", latestEvent }) });
    expect(screen.getByText("Working")).toBeTruthy();
  });
});

describe("AgentCardDetails wiring", () => {
  const worktreeAgent = makeAgent({
    cwd: "/repo/.dispatch/worktrees/worker-1",
    baseBranch: "develop",
    gitContext: {
      repoRoot: "/repo",
      branch: "agt/worker-1",
      worktreePath: "/repo/.dispatch/worktrees/worker-1",
      worktreeName: "worker-1",
      isWorktree: true,
    },
  });

  it("shows base and working branch for worktree agents, working dir otherwise", () => {
    const { rerender } = renderCard({
      agent: worktreeAgent,
      expandedAgentId: AGENT_ID,
    });

    expect(screen.getByTitle("Base branch: develop")).toBeTruthy();
    expect(screen.getByTitle("Working branch: agt/worker-1")).toBeTruthy();
    expect(screen.queryByTitle("/repo/app")).toBeNull();

    rerender({ agent: makeAgent() });
    expect(screen.queryByTitle("Base branch: develop")).toBeNull();
    expect(screen.getByTitle("/repo/app")).toBeTruthy();
  });

  it("flags full access and falls back to sandboxed, but shows neither for terminals", () => {
    const { rerender } = renderCard({
      agent: makeAgent({ fullAccess: true }),
      expandedAgentId: AGENT_ID,
    });
    expect(screen.getByText("Full access")).toBeTruthy();

    rerender({ agent: makeAgent({ fullAccess: false }) });
    expect(screen.getByText("Sandboxed")).toBeTruthy();
    expect(screen.queryByText("Full access")).toBeNull();

    rerender({ agent: makeAgent({ type: "terminal", fullAccess: true }) });
    expect(screen.queryByText("Full access")).toBeNull();
    expect(screen.queryByText("Sandboxed")).toBeNull();
  });

  it("keeps the worktree-path copy confirmation across a collapse and reopen", async () => {
    const { rerender } = renderCard({
      agent: worktreeAgent,
      expandedAgentId: AGENT_ID,
    });

    fireEvent.click(
      screen.getByLabelText(
        "Copy worktree path: /repo/.dispatch/worktrees/worker-1"
      )
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Worktree path copied")).toBeTruthy()
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "/repo/.dispatch/worktrees/worker-1"
    );

    // The copy state lives on the card, not on the details panel that unmounts.
    rerender({ expandedAgentId: null });
    rerender({ expandedAgentId: AGENT_ID });
    expect(screen.getByLabelText("Worktree path copied")).toBeTruthy();
  });
});

describe("AgentCardActions and child agents", () => {
  it("routes pause to the stop dialog and archive to the delete dialog", () => {
    const { props } = renderCard({ expandedAgentId: AGENT_ID });

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(props.setStopTarget).toHaveBeenCalledWith(props.agent);
    expect(props.setStopConfirmOpen).toHaveBeenCalledWith(true);
    expect(props.setDeleteTarget).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId(`agent-archive-${AGENT_ID}`));
    expect(props.setDeleteTarget).toHaveBeenCalledWith(props.agent);
    expect(props.setDeleteConfirmOpen).toHaveBeenCalledWith(true);
    expect(props.setStopTarget).toHaveBeenCalledTimes(1);
  });

  it("disables archiving mid-archive and swaps pause for resume when stopped", () => {
    const { rerender } = renderCard({
      agent: makeAgent({ status: "archiving" }),
      expandedAgentId: AGENT_ID,
    });
    expect(screen.getByTestId(`agent-archive-${AGENT_ID}`)).toHaveProperty(
      "disabled",
      true
    );
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();

    rerender({ agent: makeAgent({ status: "stopped" }) });
    expect(screen.getByTestId(`agent-archive-${AGENT_ID}`)).toHaveProperty(
      "disabled",
      false
    );
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Resume" }).length).toBe(2);
  });

  it("hides lifecycle actions on persona cards and credits the launching parent", () => {
    const parent = makeAgent({ name: "worker-1" });
    const persona = makeChild({ id: AGENT_ID, parentAgentId: parent.id });
    const { rerender } = renderCard({
      agent: persona,
      agents: [makeAgent({ id: "agt_launcher", name: "worker-1" })],
      expandedAgentId: AGENT_ID,
    });

    expect(screen.queryByTestId(`agent-archive-${AGENT_ID}`)).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.getByText("security-review")).toBeTruthy();

    // Parent resolved by id when it is in the list...
    rerender({
      agent: makeChild({ id: AGENT_ID, parentAgentId: "agt_launcher" }),
    });
    expect(screen.getByText("from worker-1")).toBeTruthy();

    // ...and falls back to the id suffix when it is not.
    rerender({
      agent: makeChild({ id: AGENT_ID, parentAgentId: "agt_missing_xyz789" }),
    });
    expect(screen.getByText("from xyz789")).toBeTruthy();
  });

  it("lists child agents with a count when expanded", () => {
    const children = [
      makeChild({ id: "agt_c1", persona: "security-review" }),
      makeChild({ id: "agt_c2", persona: "ux-review" }),
    ];
    const { rerender } = renderCard({
      childAgents: children,
      expandedAgentId: AGENT_ID,
    });

    expect(screen.getByText("Sub Agents")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByTestId("child-agent-row-agt_c1")).toBeTruthy();
    expect(screen.getByTestId("child-agent-row-agt_c2")).toBeTruthy();
    expect(screen.getByText("ux-review")).toBeTruthy();

    rerender({ childAgents: [] });
    expect(screen.queryByText("Sub Agents")).toBeNull();
  });

  it("surfaces the last error inside the expanded card", () => {
    renderCard({
      agent: makeAgent({ lastError: "worktree checkout failed" }),
      expandedAgentId: AGENT_ID,
    });

    expect(screen.getByText("Last error")).toBeTruthy();
    expect(screen.getByText("worktree checkout failed")).toBeTruthy();
  });
});
