// @vitest-environment jsdom
import type { ChatStatusEntry } from "@dispatch/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { isSetupEvent, SetupBlock, setupSteps } from "./setup-block";

const at = (s: number): string =>
  `2026-09-08T10:00:${String(s).padStart(2, "0")}.000Z`;

function mark(
  id: string,
  phase: string,
  message: string,
  when: string,
  extra: Partial<ChatStatusEntry> = {}
): ChatStatusEntry {
  return {
    type: "status",
    id,
    eventType:
      phase === "create" ? "blocked" : phase === "started" ? "idle" : "working",
    message,
    at: when,
    system: true,
    phase,
    ...extra,
  };
}

const worktree = mark("e1", "setup", "Creating git worktree…", at(0), {
  setupPhase: "worktree",
});
const deps = mark("e2", "setup", "Installing dependencies…", at(3), {
  setupPhase: "deps",
});
const session = mark("e3", "setup", "Starting Claude Code…", at(9), {
  setupPhase: "session",
});
const started = mark("e4", "started", "Claude Code session started.", at(12));
const failed = mark(
  "e5",
  "create",
  "Failed to create agent: no such branch",
  at(4)
);

describe("setupSteps", () => {
  it("ticks every phase but the newest, which is live until the session starts", () => {
    const live = setupSteps([worktree, deps, session]);
    expect(live.outcome).toBe("live");
    expect(live.steps.map((s) => [s.label, s.state])).toEqual([
      ["Creating git worktree", "done"],
      ["Installing dependencies", "done"],
      ["Starting Claude Code", "now"],
    ]);
    const ready = setupSteps([worktree, deps, session, started]);
    expect(ready.outcome).toBe("ready");
    expect(ready.steps.every((s) => s.state === "done")).toBe(true);
    expect(ready.endedAt).toBe(at(12));
  });

  it("marks the newest phase failed when creation fails", () => {
    const out = setupSteps([worktree, deps, failed]);
    expect(out.outcome).toBe("failed");
    expect(out.steps[1]).toMatchObject({ state: "failed" });
    expect(out.failure).toContain("no such branch");
  });

  it("recognises only Dispatch's setup marks", () => {
    expect(isSetupEvent(worktree)).toBe(true);
    expect(isSetupEvent(started)).toBe(true);
    expect(isSetupEvent(mark("x", "stop", "Session stopped.", at(1)))).toBe(
      false
    );
    expect(isSetupEvent({ ...worktree, system: undefined })).toBe(false);
  });
});

describe("SetupBlock", () => {
  afterEach(cleanup);

  it("reads Started in Ns once the session started, phases in the title", () => {
    render(<SetupBlock rows={[worktree, deps, session, started]} />);
    expect(screen.getByTestId("chat-setup-aside").textContent).toBe(
      "Started in 12s"
    );
    const block = screen.getByTestId("chat-setup-block");
    expect(block.getAttribute("data-outcome")).toBe("ready");
    expect(block.getAttribute("title")).toContain("Installing dependencies");
    expect(screen.queryByTestId("chat-setup-step")).toBeNull();
  });

  it("names the current phase while the agent is still starting", () => {
    render(<SetupBlock rows={[worktree, deps]} />);
    expect(screen.getByTestId("chat-setup-aside").textContent).toBe(
      "Installing dependencies…"
    );
    expect(
      screen.getByTestId("chat-setup-block").getAttribute("data-outcome")
    ).toBe("live");
  });

  it("shows the failure under the failed step", () => {
    render(<SetupBlock rows={[worktree, failed]} />);
    expect(screen.getByTestId("chat-setup-aside").textContent).toBe(
      "Setup failed"
    );
    expect(screen.getByTestId("chat-setup-failure").textContent).toContain(
      "no such branch"
    );
  });
});
