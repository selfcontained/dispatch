// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChildAgentRow } from "./child-agent-row";

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
  },
  mediaDir: null,
  persona: "security-review",
  parentAgentId: "agt_parent",
  createdAt: "2026-07-15T12:00:00.000Z",
  updatedAt: "2026-07-15T12:00:00.000Z",
};

afterEach(cleanup);

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
          isConnected={false}
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
  it("labels review agents and chases before their initial review is submitted", () => {
    renderRow({
      ...baseAgent,
      latestEvent: {
        type: "done",
        message: "Incorrect stale event",
        updatedAt: "2026-07-15T12:00:00.000Z",
      },
    });

    const badge = screen.getByText("Review");
    expect(badge.className.split(/\s+/)).toEqual(
      expect.arrayContaining([
        "border-primary",
        "bg-background",
        "text-foreground",
      ])
    );
    expect(badge.className).not.toContain("violet");
    const row = screen.getByTestId("child-agent-row-agt_child");
    expect(row.className).toContain("min-h-11");
    expect(row.dataset.agentRole).toBe("review");
    expect(row.dataset.reviewActive).toBe("true");
    expect(row.className).toContain("child-agent-review-active-row");
  });

  it("groups the REVIEW badge with the overflow menu control, not the truncating name label", () => {
    renderRow(baseAgent);

    const badge = screen.getByText("Review");
    const menuButton = screen.getByTestId("child-agent-menu-agt_child");
    // The badge and the overflow menu button should share an immediate
    // parent (the right-side action cluster) rather than the badge living
    // inside the name label's min-w-0/flex-1/truncate wrapper.
    expect(badge.closest("div.flex.shrink-0")).toBe(
      menuButton.closest("div.flex.shrink-0")
    );
  });

  it("stops chasing after the initial review is submitted", () => {
    renderRow(baseAgent, { isInitialReviewActive: false });

    const row = screen.getByTestId("child-agent-row-agt_child");
    expect(row.dataset.reviewActive).toBe("false");
    expect(row.className).not.toContain("child-agent-review-active-row");
  });

  it("keeps the badge muted until a review has been submitted", () => {
    renderRow(baseAgent);

    const row = screen.getByTestId("child-agent-row-agt_child");
    expect(row.dataset.reviewReady).toBe("false");
    const badge = screen.getByText("Review");
    expect(badge.className).toContain("bg-background");
    expect(badge.querySelector("svg")).toBeNull();
    // "Open review" only makes sense once a review exists.
    openMenu();
    expect(
      screen.queryByTestId("child-agent-open-review-agt_child")
    ).toBeNull();
  });

  it("marks the badge ready with a checkmark once the review can be opened, without a row border", () => {
    renderRow(
      { ...baseAgent, status: "stopped", submittedReviewId: 42 },
      { state: "stopped", isInitialReviewActive: false }
    );

    const row = screen.getByTestId("child-agent-row-agt_child");
    expect(row.dataset.reviewReady).toBe("true");
    expect(row.className).toContain("opacity-100");
    expect(row.className).not.toContain("opacity-65");
    // "Ready to open" no longer gets its own row-wide border/tint (it used
    // to read as a muted echo of the connected accent) — the badge's
    // checkmark is the sole carrier of that signal, and opening it moves to
    // the overflow menu (tested below), decoupled from connecting.
    expect(row.className).not.toContain("border-primary/45");
    expect(row.className).not.toContain("bg-primary/[0.06]");
    const badge = screen.getByText("Review");
    expect(badge.className).toContain("bg-primary");
    expect(badge.className).toContain("text-primary-foreground");
    expect(badge.querySelector("svg")).not.toBeNull();
  });

  it("opens the submitted review from the overflow menu, independent of connecting", () => {
    const submittedAgent = { ...baseAgent, submittedReviewId: 42 };
    const { attachToAgent, openSubmittedReview } = renderRow(submittedAgent, {
      isInitialReviewActive: false,
    });

    openMenu();
    fireEvent.click(screen.getByTestId("child-agent-open-review-agt_child"));
    expect(openSubmittedReview).toHaveBeenCalledWith(submittedAgent);
    expect(attachToAgent).not.toHaveBeenCalled();
  });

  it("still attaches by clicking a ready-to-open row's body, same as any other row", () => {
    // Opening the review is a menu action now — the row itself has no
    // special case for a ready-to-open review, it's click-to-connect like
    // every other row.
    const { attachToAgent } = renderRow(
      { ...baseAgent, submittedReviewId: 42 },
      { isInitialReviewActive: false, isConnected: false, state: "idle" }
    );

    fireEvent.click(screen.getByTestId("child-agent-row-agt_child"));
    expect(attachToAgent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agt_child" })
    );
  });

  it("shows the connected right-edge accent when not also ready to open", () => {
    renderRow(baseAgent, { isConnected: true, state: "active" });

    const row = screen.getByTestId("child-agent-row-agt_child");
    expect(row.className).toContain("border-r-status-done");
    expect(row.className).not.toContain("border-primary/45");
  });

  it("does not light the connected accent for a paused agent that's still attached", () => {
    // state tracks agentVisualState (running/creating AND actually
    // connected), which can diverge from the raw isConnected prop — e.g. a
    // paused agent you're still attached to. The accent should follow
    // state, matching the top-level card's own condition, not isConnected.
    renderRow(baseAgent, { isConnected: true, state: "stopped" });

    const row = screen.getByTestId("child-agent-row-agt_child");
    expect(row.className).not.toContain("border-r-status-done");
    // Falls back to the neutral default, matching every other unconnected
    // row's closed border — not a transparent gap.
    expect(row.className).toContain("border-r-border/60");
  });

  it("reserves the connected accent's width so attaching never shifts the row", () => {
    const { rerenderWith } = renderRow(baseAgent, {
      isConnected: false,
      state: "idle",
    });
    const row = screen.getByTestId("child-agent-row-agt_child");
    expect(row.className).toContain("border-r-4");
    expect(row.className).toContain("border-r-border/60");

    rerenderWith({ isConnected: true, state: "active" });
    // Same border-r-4 width both before and after — only the color class
    // toggles (see the two tests above), so the box never resizes.
    expect(row.className).toContain("border-r-4");
    expect(row.className).toContain("border-r-status-done");
  });

  it("does not infer review purpose from a persona", () => {
    renderRow({ ...baseAgent, role: "standard" });

    expect(screen.queryByText("Review")).toBeNull();
    const row = screen.getByTestId("child-agent-row-agt_child");
    expect(row.dataset.reviewActive).toBe("false");
    expect(row.className).not.toContain("child-agent-review-active-row");
  });

  describe("click-to-connect (mirrors the top-level agent card)", () => {
    it("attaches by clicking anywhere on the row", () => {
      const { attachToAgent, detachTerminal } = renderRow(
        { ...baseAgent, role: "standard" },
        { isConnected: false, state: "idle" }
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
        { isConnected: true, state: "active" }
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
        { isConnected: false, state: "idle" }
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
