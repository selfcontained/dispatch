// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@/components/app/types";
import { AgentStartup, agentStartupStage } from "./agent-startup";

const agent = {
  id: "agt_start",
  type: "dispatch",
  status: "creating",
  model: "claude/default",
} as Agent;
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("agent startup", () => {
  it.each([
    ["worktree", "Creating your workspace", 15],
    ["env", "Preparing the environment", 30],
    ["deps", "Installing dependencies", 45],
    ["session", "Preparing agent session", 65],
    [null, "Preparing your workspace", 5],
  ] as const)(
    "reports the observed %s stage",
    (setupPhase, label, progress) => {
      expect(agentStartupStage({ ...agent, setupPhase })).toMatchObject({
        label,
        progress,
      });
    }
  );

  it("continues through provider connection even when the shell is running", () => {
    expect(
      agentStartupStage({
        ...agent,
        status: "running",
        latestEvent: {
          type: "working",
          message: "Connecting",
          updatedAt: "",
          metadata: {
            source: "system",
            phase: "agent_start",
            stage: "connect",
          },
        },
      })
    ).toMatchObject({ label: "Connecting to Claude Code", progress: 80 });
  });

  it("never mistakes an ordinary working event or a stopped session for startup", () => {
    expect(agentStartupStage({ ...agent, type: "codex" })).toBeNull();
    expect(agentStartupStage({ ...agent, status: "running" })).toBeNull();
    for (const status of ["running", "error", "stopped"] as const) {
      expect(
        agentStartupStage({
          ...agent,
          status,
          latestEvent: {
            type: "working",
            message: "Connecting to something",
            updatedAt: "",
            metadata: null,
          },
        })
      ).toBeNull();
    }
  });

  it("does not invent progress while waiting, and resets the delay on stage changes", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <AgentStartup agent={{ ...agent, setupPhase: "deps" }} />
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "45"
    );
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText(/taking a little longer/)).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "45"
    );
    rerender(<AgentStartup agent={{ ...agent, setupPhase: "session" }} />);
    expect(screen.queryByText(/taking a little longer/)).toBeNull();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "65"
    );
    rerender(<AgentStartup agent={{ ...agent, status: "running" }} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});
