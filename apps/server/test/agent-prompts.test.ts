import { describe, expect, it, vi } from "vitest";

const sendCommand = vi.fn<(commandLine: string) => Promise<void>>(
  async () => {}
);
vi.mock("../src/terminal/tmux-terminal.js", () => ({
  TmuxTerminal: class {
    constructor(readonly sessionName: string) {}
    sendCommand(commandLine: string) {
      return sendCommand(`${this.sessionName}:${commandLine}`);
    }
  },
}));

import { createPromptInjector } from "../src/server/agent-prompts.js";
import { InjectionCoordinator } from "../src/terminal/injection-coordinator.js";

function build(opts: { tmux?: boolean; quietMs?: number } = {}) {
  sendCommand.mockReset();
  sendCommand.mockResolvedValue(undefined);
  const coordinator = new InjectionCoordinator({
    quietMs: opts.quietMs ?? 50,
    maxWaitMs: 1_000,
  });
  const agentManager = {
    getTerminalAccess: vi.fn(async () =>
      opts.tmux === false
        ? { mode: "inert" as const, message: "No pane." }
        : { mode: "tmux" as const, sessionName: "sess" }
    ),
  };
  const log = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  const injector = createPromptInjector(
    agentManager as never,
    log as never,
    coordinator
  );
  return { ...injector, coordinator, agentManager, log };
}

describe("enqueueAgentPrompt", () => {
  it("returns once queued and settles delivery when the pane write completes", async () => {
    const { enqueueAgentPrompt } = build();
    const { held, delivery } = await enqueueAgentPrompt("agt_1", "hello");
    expect(held).toBe(false);
    await delivery;
    expect(sendCommand).toHaveBeenCalledWith("sess:hello");
  });

  it("reports held while the quiet gate is holding an earlier delivery", async () => {
    const { enqueueAgentPrompt, coordinator } = build({ quietMs: 200 });
    coordinator.noteUserActivity("agt_1");
    const first = await enqueueAgentPrompt("agt_1", "one");
    // Let the first injection reach the gate.
    await new Promise((r) => setTimeout(r, 10));
    expect(coordinator.holdState("agt_1").held).toBe(true);
    const second = await enqueueAgentPrompt("agt_1", "two");
    expect(second.held).toBe(true);
    expect(sendCommand).not.toHaveBeenCalled();
    await Promise.all([first.delivery, second.delivery]);
    expect(sendCommand.mock.calls.map((c) => c[0])).toEqual([
      "sess:one",
      "sess:two",
    ]);
  });

  it("skips the quiet gate with gate: false", async () => {
    const { enqueueAgentPrompt, coordinator } = build({ quietMs: 500 });
    coordinator.noteUserActivity("agt_1");
    const { delivery } = await enqueueAgentPrompt("agt_1", "now", {
      gate: false,
    });
    await delivery;
    expect(sendCommand).toHaveBeenCalledWith("sess:now");
  });

  it("throws for an agent without a tmux session", async () => {
    const { enqueueAgentPrompt } = build({ tmux: false });
    await expect(enqueueAgentPrompt("agt_1", "x")).rejects.toThrow(
      /no active terminal session/
    );
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("rejects delivery when the pane write fails", async () => {
    const { enqueueAgentPrompt } = build();
    sendCommand.mockRejectedValueOnce(new Error("pane gone"));
    const { delivery } = await enqueueAgentPrompt("agt_1", "x");
    await expect(delivery).rejects.toThrow("pane gone");
  });
});

describe("injectAgentPrompt (wrapper)", () => {
  it("awaits delivery by default and swallows failures", async () => {
    const { injectAgentPrompt, log } = build();
    sendCommand.mockRejectedValueOnce(new Error("pane gone"));
    await expect(injectAgentPrompt("agt_1", "x")).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });

  it("rethrows with swallowFailure: false", async () => {
    const { injectAgentPrompt } = build({ tmux: false });
    await expect(
      injectAgentPrompt("agt_1", "x", { swallowFailure: false })
    ).rejects.toThrow(/no active terminal session/);
  });

  it("returns after enqueue with awaitDelivery: false and logs a late failure", async () => {
    const { injectAgentPrompt, log } = build({ quietMs: 200 });
    let reject!: (err: Error) => void;
    sendCommand.mockImplementationOnce(
      () =>
        new Promise<void>((_, r) => {
          reject = r;
        })
    );
    await injectAgentPrompt("agt_1", "x", { awaitDelivery: false });
    expect(log.warn).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 10));
    reject(new Error("late"));
    await new Promise((r) => setTimeout(r, 10));
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agt_1" }),
      expect.stringContaining("Deferred tmux prompt delivery failed")
    );
  });
});
