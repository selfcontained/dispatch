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
  render(
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
          {...overrides}
        />
      </TooltipProvider>
    </MemoryRouter>
  );
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
  };
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
        "ml-auto",
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

  it("stops chasing after the initial review is submitted", () => {
    renderRow(baseAgent, { isInitialReviewActive: false });

    const row = screen.getByTestId("child-agent-row-agt_child");
    expect(row.dataset.reviewActive).toBe("false");
    expect(row.className).not.toContain("child-agent-review-active-row");
  });

  it("keeps the row muted until a review has been submitted", () => {
    renderRow(baseAgent);

    const row = screen.getByTestId("child-agent-row-agt_child");
    expect(row.dataset.reviewReady).toBe("false");
    expect(row.className).not.toContain("cursor-pointer");
    const badge = screen.getByText("Review");
    expect(badge.className).toContain("bg-background");
  });

  it("lights up the row once the review can be opened", () => {
    renderRow(
      { ...baseAgent, status: "stopped", submittedReviewId: 42 },
      { state: "stopped", isInitialReviewActive: false }
    );

    const row = screen.getByTestId("child-agent-row-agt_child");
    expect(row.dataset.reviewReady).toBe("true");
    expect(row.className).toContain("cursor-pointer");
    expect(row.className).toContain("border-primary/45");
    expect(row.className).toContain("opacity-100");
    expect(row.className).not.toContain("opacity-65");
    const badge = screen.getByText("Review");
    expect(badge.className).toContain("bg-primary");
    expect(badge.className).toContain("text-primary-foreground");
  });

  it("keeps the ready treatment when the row is terminal-connected", () => {
    renderRow(
      { ...baseAgent, submittedReviewId: 42 },
      { isConnected: true, isInitialReviewActive: false }
    );

    const row = screen.getByTestId("child-agent-row-agt_child");
    expect(row.className).toContain("border-primary/45");
    expect(row.className).toContain("bg-primary/[0.06]");
    expect(row.className).toContain("hover:bg-primary/10");
    expect(row.className).toContain("cursor-pointer");
    expect(row.className).not.toContain("border-primary/35");
  });

  it("opens a submitted review from the row without attaching its terminal", () => {
    const submittedAgent = {
      ...baseAgent,
      submittedReviewId: 42,
    };
    const { attachToAgent, openSubmittedReview } = renderRow(submittedAgent, {
      isInitialReviewActive: false,
    });

    fireEvent.click(screen.getByTestId("child-agent-open-review-agt_child"));
    expect(openSubmittedReview).toHaveBeenCalledWith(submittedAgent);
    expect(attachToAgent).not.toHaveBeenCalled();
  });

  it("keeps the terminal control independent from review navigation", () => {
    const { attachToAgent, openSubmittedReview } = renderRow({
      ...baseAgent,
      submittedReviewId: 42,
    });

    const attachButton = screen.getByTestId("child-agent-attach-agt_child");
    expect(attachButton.className).toContain("h-11");
    expect(attachButton.className).toContain("w-11");
    expect(attachButton.className).toContain("sm:h-7");
    fireEvent.click(attachButton);
    expect(attachToAgent).toHaveBeenCalledOnce();
    expect(openSubmittedReview).not.toHaveBeenCalled();
  });

  it("does not infer review purpose from a persona", () => {
    renderRow({ ...baseAgent, role: "standard" });

    expect(screen.queryByText("Review")).toBeNull();
    const row = screen.getByTestId("child-agent-row-agt_child");
    expect(row.dataset.reviewActive).toBe("false");
    expect(row.className).not.toContain("child-agent-review-active-row");
  });

  it("detaches to the detached state without attaching another agent", () => {
    const { attachToAgent, detachTerminal } = renderRow(baseAgent, {
      state: "active",
      isConnected: true,
    });

    fireEvent.click(screen.getByTestId("child-agent-detach-agt_child"));
    expect(detachTerminal).toHaveBeenCalledOnce();
    expect(attachToAgent).not.toHaveBeenCalled();
  });

  describe("session actions", () => {
    // Plain children now live in this section too, so the row has to carry the
    // lifecycle controls an agent card's footer offers.
    function openMenu() {
      fireEvent.pointerDown(
        screen.getByTestId("child-agent-menu-agt_child"),
        new MouseEvent("pointerdown", { bubbles: true, button: 0 })
      );
    }

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
