// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@/components/app/types";
import { AgentStartup, agentStartupStage } from "./agent-startup";

const TICK = 250;

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

const valueNow = () =>
  Number(screen.getByRole("progressbar").getAttribute("aria-valuenow"));

describe("agent startup", () => {
  it.each([
    ["worktree", "Creating your workspace", 12],
    ["env", "Preparing the environment", 26],
    ["deps", "Installing dependencies", 40],
    ["session", "Preparing agent session", 72],
    [null, "Preparing your workspace", 3],
  ] as const)("reports the observed %s stage", (setupPhase, label, from) => {
    expect(agentStartupStage({ ...agent, setupPhase })).toMatchObject({
      label,
      from,
    });
  });

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
    ).toMatchObject({ label: "Connecting to Claude Code", from: 84 });
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

  it("creeps within a stage without ever reaching the next one", () => {
    vi.useFakeTimers();
    render(<AgentStartup agent={{ ...agent, setupPhase: "deps" }} />);
    expect(valueNow()).toBe(40);

    act(() => void vi.advanceTimersByTime(10_000));
    const early = valueNow();
    expect(early).toBeGreaterThan(40);

    act(() => void vi.advanceTimersByTime(20_000));
    expect(valueNow()).toBeGreaterThan(early);

    // Even far past the stage's expected duration it stays below the ceiling,
    // so the next stage always has somewhere to land.
    act(() => void vi.advanceTimersByTime(10 * 60_000));
    expect(valueNow()).toBeLessThan(72);
  });

  it("does not fall backwards when a later stage arrives, and resets the delay", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <AgentStartup agent={{ ...agent, setupPhase: "deps" }} />
    );
    act(() => void vi.advanceTimersByTime(60_000));
    expect(screen.getByText(/taking a little longer/)).toBeTruthy();
    const crept = valueNow();

    rerender(<AgentStartup agent={{ ...agent, setupPhase: "session" }} />);
    act(() => void vi.advanceTimersByTime(TICK));
    expect(screen.queryByText(/taking a little longer/)).toBeNull();
    expect(valueNow()).toBeGreaterThanOrEqual(crept);

    rerender(<AgentStartup agent={{ ...agent, status: "running" }} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("wears the provider's mark", () => {
    render(<AgentStartup agent={{ ...agent, setupPhase: "deps" }} />);
    expect(screen.getByTestId("provider-icon").dataset.provider).toBe(
      "anthropic"
    );
  });

  it("falls back to the Dispatch mark when the model names no provider", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AgentStartup
          agent={{ ...agent, setupPhase: "deps", model: "mystery/model" }}
        />
      </QueryClientProvider>
    );
    expect(screen.queryByTestId("provider-icon")).toBeNull();
    const mark = screen.getByTestId("chat-agent-startup-mark");
    expect(mark.querySelector("img")?.getAttribute("src")).toContain(
      "harness-icon.svg"
    );
  });
});
