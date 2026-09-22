// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChildAgentRow } from "./child-agent-row";

// The chat badge reads an app-wide React Query summary; the row only has to
// place it, so the hook is a switch here.
const chatUnread = vi.hoisted(() => ({
  value: { unread: 0, pendingQuestions: 0 },
}));
vi.mock("@/hooks/use-chat-unread-summary", () => ({
  useAgentChatUnread: () => chatUnread.value,
}));

// The running turn's verb comes from the app-wide React Query cache.
const turnLabel = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("@/hooks/use-agent-turn-label", () => ({
  useAgentTurnLabel: () => turnLabel.value,
}));

const baseAgent: Agent = {
  id: "agt_child",
  name: "security-review-123456",
  type: "codex",
  role: "review",
  status: "running",
  cwd: "/repo",
  worktreePath: null,
  worktreeBranch: null,
  agentArgs: [],
  model: null,
  fullAccess: false,
  latestEvent: {
    type: "working",
    message: "Reviewing changed routes",
    updatedAt: "2026-07-15T12:00:00.000Z",
    metadata: {},
  },
  filesDir: null,
  persona: "security-review",
  parentAgentId: "agt_parent",
  createdAt: "2026-07-15T12:00:00.000Z",
  updatedAt: "2026-07-15T12:00:00.000Z",
};

afterEach(() => {
  cleanup();
  chatUnread.value = { unread: 0, pendingQuestions: 0 };
  turnLabel.value = null;
});

function renderRow(
  agent: Agent,
  overrides: Partial<ComponentProps<typeof ChildAgentRow>> = {}
) {
  const openAgent = vi.fn().mockResolvedValue(undefined);
  const closeAgent = vi.fn();
  const startAgent = vi.fn().mockResolvedValue(undefined);
  const setStopTarget = vi.fn();
  const setStopConfirmOpen = vi.fn();
  const setDeleteTarget = vi.fn();
  const setDeleteConfirmOpen = vi.fn();
  const onEditSettings = vi.fn();
  const buildElement = (
    elementOverrides: Partial<ComponentProps<typeof ChildAgentRow>> = {}
  ) => (
    <MemoryRouter>
      <TooltipProvider>
        <ChildAgentRow
          agent={agent}
          seat={2}
          state="idle"
          isInitialReviewActive={true}
          openAgent={openAgent}
          closeAgent={closeAgent}
          startAgent={startAgent}
          setStopTarget={setStopTarget}
          setStopConfirmOpen={setStopConfirmOpen}
          setDeleteTarget={setDeleteTarget}
          setDeleteConfirmOpen={setDeleteConfirmOpen}
          onEditSettings={onEditSettings}
          {...elementOverrides}
        />
      </TooltipProvider>
    </MemoryRouter>
  );
  const { rerender } = render(buildElement(overrides));
  return {
    openAgent,
    closeAgent,
    startAgent,
    setStopTarget,
    setStopConfirmOpen,
    setDeleteTarget,
    setDeleteConfirmOpen,
    onEditSettings,
    rerenderWith: (
      elementOverrides: Partial<ComponentProps<typeof ChildAgentRow>>
    ) => rerender(buildElement({ ...overrides, ...elementOverrides })),
  };
}

function openMenu(agentId = "agt_child") {
  fireEvent.pointerDown(
    screen.getByTestId(`child-agent-menu-${agentId}`),
    new MouseEvent("pointerdown", { bubbles: true, button: 0 })
  );
}

describe("ChildAgentRow", () => {
  describe("chat unread badge", () => {
    it("shows nothing while the child has no unread chat", () => {
      renderRow(baseAgent);
      expect(screen.queryByTestId("agent-chat-unread")).toBeNull();
    });

    it("shows the unread count for a child with replies waiting", () => {
      chatUnread.value = { unread: 2, pendingQuestions: 0 };
      renderRow(baseAgent);
      const badge = screen.getByTestId("agent-chat-unread");
      expect(badge.textContent).toBe("2");
      expect(badge.className).not.toContain("status-waiting");
    });

    it("takes the waiting accent when the child asked a question", () => {
      chatUnread.value = { unread: 0, pendingQuestions: 1 };
      renderRow(baseAgent);
      const badge = screen.getByTestId("agent-chat-unread");
      expect(badge.className).toContain("status-waiting");
      expect(badge.getAttribute("title")).toBe("1 open question");
    });
  });

  it("labels review agents and chases before their initial review is submitted", () => {
    renderRow({
      ...baseAgent,
      latestEvent: {
        type: "done",
        message: "Incorrect stale event",
        updatedAt: "2026-07-15T12:00:00.000Z",
        metadata: {},
      },
    });

    const indicator = screen.getByRole("img", { name: "Review in progress" });
    expect(indicator.className).toContain("text-muted-foreground");
    const row = screen.getByTestId("child-agent-row-agt_child");
    expect(row.className).toContain("min-h-11");
    expect(row.dataset.agentRole).toBe("review");
    expect(row.dataset.reviewActive).toBe("true");
    expect(row.className).toContain("child-agent-review-active-row");
  });

  it("groups the review indicator with the overflow menu control, not the truncating name label", () => {
    renderRow(baseAgent);

    const indicator = screen.getByRole("img", { name: "Review in progress" });
    const menuButton = screen.getByTestId("child-agent-menu-agt_child");
    // The indicator and the overflow menu button should share an immediate
    // parent (the right-side action cluster) rather than living inside the
    // name label's min-w-0/flex-1/truncate wrapper.
    expect(indicator.closest("div.flex.shrink-0")).toBe(
      menuButton.closest("div.flex.shrink-0")
    );
  });

  it("stops chasing after the initial review is submitted", () => {
    renderRow(baseAgent, { isInitialReviewActive: false });

    const row = screen.getByTestId("child-agent-row-agt_child");
    expect(row.dataset.reviewActive).toBe("false");
    expect(row.className).not.toContain("child-agent-review-active-row");
  });

  it("shows the muted clipboard-list indicator for a reviewer", () => {
    renderRow(baseAgent);

    const indicator = screen.getByRole("img", { name: "Review in progress" });
    expect(indicator.querySelector("svg.lucide-clipboard-list")).not.toBeNull();
    // The review itself lands in the parent's stream; the row has no
    // "open review" action of its own.
    openMenu();
    expect(
      screen.queryByTestId("child-agent-open-review-agt_child")
    ).toBeNull();
  });

  describe("keyboard/screen-reader open access (the overflow menu's Open / Close item)", () => {
    it("attaches from the menu when not connected", () => {
      const { openAgent } = renderRow(
        { ...baseAgent, role: "standard" },
        { state: "idle" }
      );

      openMenu();
      fireEvent.click(screen.getByTestId("child-agent-open-agt_child"));
      expect(openAgent).toHaveBeenCalledWith(
        expect.objectContaining({ id: "agt_child" })
      );
    });

    it("detaches from the menu when connected", () => {
      const { closeAgent } = renderRow(
        { ...baseAgent, role: "standard" },
        { state: "active" }
      );

      openMenu();
      const item = screen.getByTestId("child-agent-open-agt_child");
      expect(item.textContent).toContain("Close");
      fireEvent.click(item);
      expect(closeAgent).toHaveBeenCalledOnce();
    });

    it("is absent for a stopped agent, which uses Resume instead", () => {
      const stopped = { ...baseAgent, status: "stopped" as const };
      renderRow(stopped, { state: "stopped" });

      openMenu();
      expect(screen.queryByTestId("child-agent-open-agt_child")).toBeNull();
    });
  });

  it("shows the connected right-edge accent when not also ready to open", () => {
    renderRow(baseAgent, { state: "active" });

    const row = screen.getByTestId("child-agent-row-agt_child");
    expect(row.className).toContain("border-r-4");
    expect(row.className).toContain("border-r-status-done");
    expect(row.className).not.toContain("border-primary/45");
  });

  it("does not light the connected accent for a paused agent that's still attached", () => {
    // state tracks agentVisualState (running/creating AND actually
    // connected) — the accent (and the row's click-to-detach) follow it,
    // not any looser notion of "was ever attached."
    renderRow(baseAgent, { state: "stopped" });

    const row = screen.getByTestId("child-agent-row-agt_child");
    expect(row.className).not.toContain("border-r-4");
    expect(row.className).not.toContain("border-r-status-done");
    // A normal 1px border matching the row's other sides — not a thick
    // reserved edge (muted or invisible), just an ordinary bordered pill.
    expect(row.className).toContain("border-border/60");
  });

  it("describes a paused reviewer's pending indicator differently from an active one", () => {
    // canOpenSubmittedReview is just "no submission yet" — much broader
    // than "actively working." A stopped reviewer never submitted, so
    // "Review in progress" would misdescribe it.
    renderRow(
      { ...baseAgent, status: "stopped" },
      { state: "stopped", isInitialReviewActive: false }
    );

    expect(
      screen.queryByRole("img", { name: "Review in progress" })
    ).toBeNull();
    // Throws (failing the test) if not found — this is the assertion.
    screen.getByRole("img", { name: "Review agent — paused" });
  });

  it("does not infer review purpose from a persona", () => {
    renderRow({ ...baseAgent, role: "standard" });

    expect(
      screen.queryByRole("img", { name: "Review in progress" })
    ).toBeNull();
    const row = screen.getByTestId("child-agent-row-agt_child");
    expect(row.dataset.reviewActive).toBe("false");
    expect(row.className).not.toContain("child-agent-review-active-row");
  });

  describe("click-to-connect (mirrors the top-level agent card)", () => {
    it("attaches by clicking anywhere on the row", () => {
      const { openAgent, closeAgent } = renderRow(
        { ...baseAgent, role: "standard" },
        { state: "idle" }
      );

      fireEvent.click(screen.getByTestId("child-agent-row-agt_child"));
      expect(openAgent).toHaveBeenCalledWith(
        expect.objectContaining({ id: "agt_child" })
      );
      expect(closeAgent).not.toHaveBeenCalled();
    });

    it("detaches by clicking an already-connected row", () => {
      const { openAgent, closeAgent } = renderRow(
        { ...baseAgent, role: "standard" },
        { state: "active" }
      );

      fireEvent.click(screen.getByTestId("child-agent-row-agt_child"));
      expect(closeAgent).toHaveBeenCalledOnce();
      expect(openAgent).not.toHaveBeenCalled();
    });

    it("does not attach or detach by clicking a stopped row", () => {
      const stopped = {
        ...baseAgent,
        role: "standard" as const,
        status: "stopped" as const,
      };
      const { openAgent, closeAgent } = renderRow(stopped, {
        state: "stopped",
      });

      const row = screen.getByTestId("child-agent-row-agt_child");
      expect(row.className).not.toContain("cursor-pointer");
      fireEvent.click(row);
      expect(openAgent).not.toHaveBeenCalled();
      expect(closeAgent).not.toHaveBeenCalled();
    });

    it("does not attach when clicking the overflow menu button", () => {
      const { openAgent } = renderRow(
        { ...baseAgent, role: "standard" },
        { state: "idle" }
      );

      fireEvent.click(screen.getByTestId("child-agent-menu-agt_child"));
      expect(openAgent).not.toHaveBeenCalled();
    });

    it("does not attach when clicking the resume button on a stopped row", () => {
      const stopped = {
        ...baseAgent,
        role: "standard" as const,
        status: "stopped" as const,
      };
      const { openAgent, startAgent } = renderRow(stopped, {
        state: "stopped",
      });

      fireEvent.click(screen.getByTestId("child-agent-resume-agt_child"));
      expect(startAgent).toHaveBeenCalledWith(stopped);
      expect(openAgent).not.toHaveBeenCalled();
    });
  });

  describe("session actions", () => {
    // Plain children now live in this section too, so the row has to carry the
    // lifecycle controls an agent card's footer offers.
    it("archives the sub agent through the shared confirmation dialog", () => {
      const { setDeleteTarget, setDeleteConfirmOpen } = renderRow(baseAgent);

      openMenu();
      fireEvent.click(screen.getByTestId("child-agent-archive-agt_child"));

      expect(setDeleteTarget).toHaveBeenCalledWith(baseAgent);
      expect(setDeleteConfirmOpen).toHaveBeenCalledWith(true);
    });

    it("pauses a running sub agent", () => {
      const { setStopTarget, setStopConfirmOpen } = renderRow(baseAgent);

      openMenu();
      fireEvent.click(screen.getByTestId("child-agent-pause-agt_child"));

      expect(setStopTarget).toHaveBeenCalledWith(baseAgent);
      expect(setStopConfirmOpen).toHaveBeenCalledWith(true);
    });

    it("offers resume instead of pause once the sub agent is stopped", () => {
      const stopped = { ...baseAgent, status: "stopped" as const };
      const { startAgent } = renderRow(stopped, { state: "stopped" });

      openMenu();
      expect(screen.queryByTestId("child-agent-pause-agt_child")).toBeNull();
      fireEvent.click(screen.getByTestId("child-agent-menu-resume-agt_child"));

      expect(startAgent).toHaveBeenCalledWith(stopped);
    });

    it("opens session settings for the sub agent, not its parent", () => {
      const { onEditSettings } = renderRow(baseAgent);

      openMenu();
      fireEvent.click(screen.getByTestId("child-agent-settings-agt_child"));

      expect(onEditSettings).toHaveBeenCalledWith(baseAgent);
    });

    it("disables archive while the sub agent is already archiving", () => {
      renderRow({ ...baseAgent, status: "archiving" });

      openMenu();
      expect(
        screen
          .getByTestId("child-agent-archive-agt_child")
          .getAttribute("aria-disabled")
      ).toBe("true");
      expect(screen.queryByTestId("child-agent-pause-agt_child")).toBeNull();
    });
  });
});

describe("ChildAgentRow running-turn link", () => {
  function LocationProbe() {
    const location = useLocation();
    return (
      <div data-testid="location">
        {location.pathname}
        {location.search}
      </div>
    );
  }

  function renderLinkRow(agent: Agent) {
    const openAgent = vi.fn().mockResolvedValue(undefined);
    const closeAgent = vi.fn();
    render(
      <MemoryRouter initialEntries={["/agents/agt_parent"]}>
        <TooltipProvider>
          <ChildAgentRow
            agent={agent}
            seat={2}
            state="idle"
            isInitialReviewActive={false}
            openAgent={openAgent}
            closeAgent={closeAgent}
            startAgent={vi.fn()}
            setStopTarget={vi.fn()}
            setStopConfirmOpen={vi.fn()}
            setDeleteTarget={vi.fn()}
            setDeleteConfirmOpen={vi.fn()}
            onEditSettings={vi.fn()}
          />
        </TooltipProvider>
        <LocationProbe />
      </MemoryRouter>
    );
    return { openAgent, closeAgent };
  }

  const working: Agent = {
    ...baseAgent,
    activity: "working",
    currentTurn: { blockId: "blk_turn", threadId: null },
  };

  it("links the activity only while the child is working", () => {
    renderLinkRow(working);
    const label = screen.getByTestId("agent-activity-agt_child");
    expect(label.tagName).toBe("BUTTON");
    expect(label.getAttribute("data-turn-link")).toBe("blk_turn");
    cleanup();

    renderLinkRow({ ...working, activity: "waiting" });
    expect(screen.getByTestId("agent-activity-agt_child").tagName).toBe("DIV");
    cleanup();

    // Working, but the turn's block is not known (yet): nothing to go to.
    renderLinkRow({ ...working, currentTurn: null });
    expect(screen.getByTestId("agent-activity-agt_child").tagName).toBe("DIV");
  });

  it("opens the child's page on its turn without the row's own click", () => {
    const { openAgent, closeAgent } = renderLinkRow(working);
    fireEvent.click(screen.getByTestId("agent-activity-agt_child"));
    expect(screen.getByTestId("location").textContent).toBe(
      "/agents/agt_child?block=blk_turn"
    );
    expect(openAgent).not.toHaveBeenCalled();
    expect(closeAgent).not.toHaveBeenCalled();
  });

  it("opens the thread a turn sits in, on the turn", () => {
    renderLinkRow({
      ...working,
      currentTurn: { blockId: "blk_turn", threadId: "blk_launch" },
    });
    fireEvent.click(screen.getByTestId("agent-activity-agt_child"));
    expect(screen.getByTestId("location").textContent).toBe(
      "/agents/agt_child?thread=blk_launch&block=blk_turn"
    );
  });
});
