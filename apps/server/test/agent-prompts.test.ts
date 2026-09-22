import { describe, expect, it, vi } from "vitest";

import { createPromptInjector } from "../src/server/agent-prompts.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function build(opts: { live?: boolean; held?: boolean } = {}) {
  let accepted = deferred();
  let settled = deferred();
  const agentManager = {
    getTerminalAccess: vi.fn(async () =>
      opts.live === false
        ? { mode: "inert" as const, message: "Agent is stopped." }
        : { mode: "live" as const }
    ),
    promptAgent: vi.fn(() => ({
      accepted: accepted.promise,
      settled: settled.promise,
    })),
    isPromptHeld: vi.fn(() => opts.held ?? false),
  };
  const log = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  const injector = createPromptInjector(agentManager as never, log as never);
  return {
    ...injector,
    agentManager,
    log,
    get accepted() {
      return accepted;
    },
    get settled() {
      return settled;
    },
    reset() {
      accepted = deferred();
      settled = deferred();
    },
  };
}

describe("enqueueAgentPrompt", () => {
  it("hands the prompt to the runtime and settles delivery on accept", async () => {
    const ctx = build();
    const { held, delivery } = await ctx.enqueueAgentPrompt("agt_1", "hello");
    expect(held).toBe(false);
    expect(ctx.agentManager.promptAgent).toHaveBeenCalledWith(
      "agt_1",
      "hello",
      undefined,
      undefined
    );
    ctx.accepted.resolve();
    await expect(delivery).resolves.toBeUndefined();
  });

  it("passes what the prompt is through to the runtime", async () => {
    const ctx = build();
    // The block the envelope carries, so the turn it opens can be tied
    // back to it without reading the id out of the envelope again.
    const source = {
      source: "chat" as const,
      chatMessageId: "11111111-2222-4333-8444-555555555555",
    };
    await ctx.enqueueAgentPrompt("agt_1", "hello", { source });
    expect(ctx.agentManager.promptAgent).toHaveBeenCalledWith(
      "agt_1",
      "hello",
      source,
      undefined
    );
  });

  it("asks for an interrupting prompt to go alone", async () => {
    const ctx = build();
    await ctx.enqueueAgentPrompt("agt_1", "stop", { alone: true });
    expect(ctx.agentManager.promptAgent).toHaveBeenCalledWith(
      "agt_1",
      "stop",
      undefined,
      { alone: true }
    );
  });

  it("reports held when a turn is already running", async () => {
    const ctx = build({ held: true });
    const { held } = await ctx.enqueueAgentPrompt("agt_1", "two");
    expect(held).toBe(true);
    expect(ctx.agentManager.isPromptHeld).toHaveBeenCalledWith("agt_1");
  });

  it("throws for an agent without a live session", async () => {
    const ctx = build({ live: false });
    await expect(ctx.enqueueAgentPrompt("agt_1", "x")).rejects.toThrow(
      /no live session/
    );
    expect(ctx.agentManager.promptAgent).not.toHaveBeenCalled();
  });

  it("rejects delivery when the runtime refuses the prompt", async () => {
    const ctx = build();
    const { delivery } = await ctx.enqueueAgentPrompt("agt_1", "x");
    ctx.accepted.reject(new Error("host gone"));
    await expect(delivery).rejects.toThrow("host gone");
  });

  it("logs a failed turn instead of leaving the rejection unhandled", async () => {
    const ctx = build();
    await ctx.enqueueAgentPrompt("agt_1", "x");
    ctx.settled.reject(new Error("turn died"));
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agt_1" }),
      "agent turn failed"
    );
  });
});

describe("injectAgentPrompt (wrapper)", () => {
  it("awaits delivery by default and swallows failures", async () => {
    const ctx = build();
    const pending = ctx.injectAgentPrompt("agt_1", "x");
    await new Promise((r) => setTimeout(r, 0));
    ctx.accepted.reject(new Error("host gone"));
    await expect(pending).resolves.toBeUndefined();
    expect(ctx.log.warn).toHaveBeenCalled();
  });

  it("skips quietly when the agent has no live session", async () => {
    const ctx = build({ live: false });
    await expect(ctx.injectAgentPrompt("agt_1", "x")).resolves.toBeUndefined();
    expect(ctx.log.debug).toHaveBeenCalled();
    expect(ctx.log.warn).not.toHaveBeenCalled();
  });

  it("rethrows with swallowFailure: false", async () => {
    const ctx = build({ live: false });
    await expect(
      ctx.injectAgentPrompt("agt_1", "x", { swallowFailure: false })
    ).rejects.toThrow(/no live session/);
  });

  it("returns after enqueue with awaitDelivery: false and logs a late failure", async () => {
    const ctx = build();
    await ctx.injectAgentPrompt("agt_1", "x", { awaitDelivery: false });
    expect(ctx.log.warn).not.toHaveBeenCalled();
    ctx.accepted.reject(new Error("late"));
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agt_1" }),
      expect.stringContaining("Deferred prompt delivery failed")
    );
  });
});
