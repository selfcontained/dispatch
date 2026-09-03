// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
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

const baseAgent: Agent = {
  id: "agt_child",
  name: "security-review-123456",
  type: "codex",
  role: "review",
  status: "running",
  cwd: "/repo",
  worktreePath: null,
  worktreeBranch: null,
  tmuxSession: "dispatch-agt_child",
  agentArgs: [],
  model: null,
  fullAccess: false,
  latestEvent: {
    type: "working",
    message: "Reviewing changed routes",
    updatedAt: "2026-07-15T12:00:00.000Z",
    metadata: {},
  },
  mediaDir: null,
  persona: "security-review",
  parentAgentId: "agt_parent",
  createdAt: "2026-07-15T12:00:00.000Z",
  updatedAt: "2026-07-15T12:00:00.000Z",
};

afterEach(() => {
  cleanup();
  chatUnread.value = { unread: 0, pendingQuestions: 0 };
});

function renderRow(
  agent: Agent,
  overrides: Partial<ComponentProps<typeof ChildAgentRow>> = {}
) {
  const attachToAgent = vi.fn().mockResolvedValue(undefined);
  const detachTerminal = vi.fn();
  const startAgent = vi.fn().mockResolvedValue(undefined);
  const openSubmittedReview = vi.fn();
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
          state="idle"
          isInitialReviewActive={true}
          attachToAgent={attachToAgent}
          detachTerminal={detachTerminal}
          startAgent={startAgent}
          openSubmittedReview={openSubmittedReview}
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
    attachToAgent,
    detachTerminal,
    startAgent,
    openSubmittedReview,
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

  it("shows the muted clipboard-list indicator until a review has been submitted", () => {
    renderRow(baseAgent);

    const row = screen.getByTestId("child-agent-row-agt_child");
    expect(row.dataset.reviewReady).toBe("false");
    const indicator = screen.getByRole("img", { name: "Review in progress" });
    expect(indicator.querySelector("svg.lucide-clipboard-list")).not.toBeNull();
    expect(indicator.querySelector("svg.lucide-clipboard-check")).toBeNull();
    // "Open review" only makes sense once a review exists.
    openMenu();
    expect(
      screen.queryByTestId("child-agent-open-review-agt_child")
    ).toBeNull();
  });

  it("swaps to a colored clipboard-check indicator once the review can be opened, without a row border", () => {
    renderRow(
      { ...baseAgent, status: "stopped", submittedReviewId: 42 },
      { state: "stopped", isInitialReviewActive: false }
    );

    const row = screen.getByTestId("child-agent-row-agt_child");
    expect(row.dataset.reviewReady).toBe("true");
    expect(row.className).toContain("opacity-100");
    expect(row.className).not.toContain("opacity-65");
    // "Ready to open" no longer gets its own row-wide border/tint (it used
    // to read as a muted echo of the connected accent) — the indicator's
    // color/icon swap is the sole carrier of that signal, and opening it
    // moves to the overflow menu (tested below), decoupled from connecting.
    expect(row.className).not.toContain("border-primary/45");
    expect(row.className).not.toContain("bg-primary/[0.06]");
    const trigger = screen.getByTestId(
      "child-agent-open-review-badge-agt_child"
    );
    // status-working (green), deliberately not the same color family as the
    // connected accent (status-done/primary, blue in this theme) — the two
    // signals must never look like variants of each other.
    expect(trigger.className).toContain("text-status-working");
    expect(trigger.querySelector("svg.lucide-clipboard-check")).not.toBeNull();
  });

  it("opens the submitted review from the overflow menu, independent of connecting", () => {
    const submittedAgent = { ...baseAgent, submittedReviewId: 42 };
    const { attachToAgent, openSubmittedReview } = renderRow(submittedAgent, {
      isInitialReviewActive: false,
    });

    openMenu();
    fireEvent.click(screen.getByTestId("child-agent-open-review-agt_child"));
    expect(openSubmittedReview).toHaveBeenCalledWith(submittedAgent);
    // Also proves the portal-bubbling fix: DropdownMenuContent is portaled
    // outside the row's real DOM, but React's synthetic events still
    // bubble through the *component* tree — without the row's
    // currentTarget.contains() guard, this click would also attach.
    expect(attachToAgent).not.toHaveBeenCalled();
  });

  it("opens the submitted review by clicking its own badge, not the row", () => {
    const submittedAgent = { ...baseAgent, submittedReviewId: 42 };
    const { attachToAgent, openSubmittedReview } = renderRow(submittedAgent, {
      isInitialReviewActive: false,
    });

    fireEvent.click(
      screen.getByTestId("child-agent-open-review-badge-agt_child")
    );
    expect(openSubmittedReview).toHaveBeenCalledWith(submittedAgent);
    expect(attachToAgent).not.toHaveBeenCalled();
  });

  it("keeps the badge trigger reachable on a stopped, ready-to-open row", () => {
    // The row's own click-to-connect is a dead end here (isStopped bails
    // out), so the badge is the only way to reach the review without
    // opening the overflow menu — worth pinning explicitly.
    const submittedAgent = {
      ...baseAgent,
      status: "stopped" as const,
      submittedReviewId: 42,
    };
    const { openSubmittedReview } = renderRow(submittedAgent, {
      state: "stopped",
      isInitialReviewActive: false,
    });

    fireEvent.click(
      screen.getByTestId("child-agent-open-review-badge-agt_child")
    );
    expect(openSubmittedReview).toHaveBeenCalledWith(submittedAgent);
  });

  it("renders the badge plain (not a button) before a review is submitted", () => {
    renderRow(baseAgent);

    expect(
      screen.queryByTestId("child-agent-open-review-badge-agt_child")
    ).toBeNull();
  });

  describe("keyboard/screen-reader terminal access (the overflow menu's View terminal / Detach item)", () => {
    it("attaches from the menu when not connected", () => {
      const { attachToAgent } = renderRow(
        { ...baseAgent, role: "standard" },
        { state: "idle" }
      );

      openMenu();
      fireEvent.click(screen.getByTestId("child-agent-terminal-agt_child"));
      expect(attachToAgent).toHaveBeenCalledWith(
        expect.objectContaining({ id: "agt_child" })
      );
    });

    it("detaches from the menu when connected", () => {
      const { detachTerminal } = renderRow(
        { ...baseAgent, role: "standard" },
        { state: "active" }
      );

      openMenu();
      const item = screen.getByTestId("child-agent-terminal-agt_child");
      expect(item.textContent).toContain("Detach");
      fireEvent.click(item);
      expect(detachTerminal).toHaveBeenCalledOnce();
    });

    it("is absent for a stopped agent, which uses Resume instead", () => {
      const stopped = { ...baseAgent, status: "stopped" as const };
      renderRow(stopped, { state: "stopped" });

      openMenu();
      expect(screen.queryByTestId("child-agent-terminal-agt_child")).toBeNull();
    });
  });

  it("still attaches by clicking a ready-to-open row's body, same as any other row", () => {
    // Opening the review is a menu action now — the row itself has no
    // special case for a ready-to-open review, it's click-to-connect like
    // every other row.
    const { attachToAgent } = renderRow(
      { ...baseAgent, submittedReviewId: 42 },
      { isInitialReviewActive: false, state: "idle" }
    );

    fireEvent.click(screen.getByTestId("child-agent-row-agt_child"));
    expect(attachToAgent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agt_child" })
    );
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
    screen.getByRole("img", {
      name: "Review agent — paused, no review submitted",
    });
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
      const { attachToAgent, detachTerminal } = renderRow(
        { ...baseAgent, role: "standard" },
        { state: "idle" }
      );

      fireEvent.click(screen.getByTestId("child-agent-row-agt_child"));
      expect(attachToAgent).toHaveBeenCalledWith(
        expect.objectContaining({ id: "agt_child" })
      );
      expect(detachTerminal).not.toHaveBeenCalled();
    });

    it("detaches by clicking an already-connected row", () => {
      const { attachToAgent, detachTerminal } = renderRow(
        { ...baseAgent, role: "standard" },
        { state: "active" }
      );

      fireEvent.click(screen.getByTestId("child-agent-row-agt_child"));
      expect(detachTerminal).toHaveBeenCalledOnce();
      expect(attachToAgent).not.toHaveBeenCalled();
    });

    it("does not attach or detach by clicking a stopped row", () => {
      const stopped = {
        ...baseAgent,
        role: "standard" as const,
        status: "stopped" as const,
      };
      const { attachToAgent, detachTerminal } = renderRow(stopped, {
        state: "stopped",
      });

      const row = screen.getByTestId("child-agent-row-agt_child");
      expect(row.className).not.toContain("cursor-pointer");
      fireEvent.click(row);
      expect(attachToAgent).not.toHaveBeenCalled();
      expect(detachTerminal).not.toHaveBeenCalled();
    });

    it("does not attach when clicking the overflow menu button", () => {
      const { attachToAgent } = renderRow(
        { ...baseAgent, role: "standard" },
        { state: "idle" }
      );

      fireEvent.click(screen.getByTestId("child-agent-menu-agt_child"));
      expect(attachToAgent).not.toHaveBeenCalled();
    });

    it("does not attach when clicking the resume button on a stopped row", () => {
      const stopped = {
        ...baseAgent,
        role: "standard" as const,
        status: "stopped" as const,
      };
      const { attachToAgent, startAgent } = renderRow(stopped, {
        state: "stopped",
      });

      fireEvent.click(screen.getByTestId("child-agent-resume-agt_child"));
      expect(startAgent).toHaveBeenCalledWith(stopped);
      expect(attachToAgent).not.toHaveBeenCalled();
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
