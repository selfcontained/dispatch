// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
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
  render(
    <TooltipProvider>
      <ChildAgentRow
        agent={agent}
        state="idle"
        isInitialReviewActive={true}
        isConnected={false}
        attachToAgent={attachToAgent}
        detachTerminal={detachTerminal}
        startAgent={startAgent}
        {...overrides}
      />
    </TooltipProvider>
  );
  return { attachToAgent, detachTerminal, startAgent };
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

    expect(screen.getByText("Review")).toBeTruthy();
    const row = screen.getByTestId("child-agent-row-agt_child");
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
});
