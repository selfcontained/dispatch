import { describe, expect, it, vi } from "vitest";

import { createAgentEventBus } from "../src/agents/events.js";
import type { AgentRecord } from "../src/agents/types.js";

const makeAgent = (
  id: string,
  overrides: Partial<AgentRecord> = {}
): AgentRecord => {
  // Minimal AgentRecord shape — bus only forwards the object as-is, so most
  // fields can be loose.
  return {
    id,
    name: id,
    type: "claude",
    role: "standard",
    status: "running",
    cwd: "/tmp",
    worktreePath: null,
    worktreeBranch: null,
    tmuxSession: null,
    simulatorUdid: null,
    mediaDir: null,
    agentArgs: [],
    fullAccess: false,
    setupPhase: null,
    archivePhase: null,
    archiveCleanupMode: null,
    lastError: null,
    latestEvent: null,
    pins: [],
    gitContext: null,
    gitContextStale: false,
    gitContextUpdatedAt: null,
    persona: null,
    parentAgentId: null,
    personaContext: null,
    reviewAgentType: null,
    review: null,
    baseBranch: null,
    autoReview: false,
    cliSessionId: null,
    createdAt: "2026-04-29T00:00:00Z",
    updatedAt: "2026-04-29T00:00:00Z",
    ...overrides,
  };
};

const noopLogger = (() => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: "silent",
  };
  return Object.assign(logger, {
    child: () => noopLogger,
  }) as unknown as import("fastify").FastifyBaseLogger;
})();

describe("createAgentEventBus", () => {
  it("delivers a published agent to every subscribed listener", () => {
    const bus = createAgentEventBus(noopLogger);
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe(a);
    bus.subscribe(b);

    const agent = makeAgent("agt_a");
    bus.publish(agent);

    expect(a).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith(agent);
    expect(b).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledWith(agent);
  });

  it("delivers each publish independently — listeners receive every call, in order", () => {
    const bus = createAgentEventBus(noopLogger);
    const calls: string[] = [];
    bus.subscribe((agent) => {
      calls.push(`one:${agent.id}`);
    });
    bus.subscribe((agent) => {
      calls.push(`two:${agent.id}`);
    });

    bus.publish(makeAgent("agt_1"));
    bus.publish(makeAgent("agt_2"));

    expect(calls).toEqual(["one:agt_1", "two:agt_1", "one:agt_2", "two:agt_2"]);
  });

  it("isolates listener throws — a thrower does not stop later listeners", () => {
    const warnSpy = vi.fn();
    const logger = {
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      silent: vi.fn(),
      level: "silent",
      child: () => logger,
    } as unknown as import("fastify").FastifyBaseLogger;
    const bus = createAgentEventBus(logger);

    const after = vi.fn();
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe(after);

    bus.publish(makeAgent("agt_x"));

    // Subsequent listener still ran.
    expect(after).toHaveBeenCalledTimes(1);
    // The throw was logged but not propagated to the publisher.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[1]).toBe("Agent event listener threw");
  });

  it("isolates async-listener rejections — a rejecting Promise is caught and logged", async () => {
    // The AgentEventListener type is `(agent) => void`, but TS structurally
    // accepts `async (agent) => Promise<void>`. The bus must catch the
    // rejection of an async listener too — otherwise it surfaces as an
    // unhandled rejection and the contract advertised by `publish`'s JSDoc
    // is half-true.
    const warnSpy = vi.fn();
    const logger = {
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      silent: vi.fn(),
      level: "silent",
      child: () => logger,
    } as unknown as import("fastify").FastifyBaseLogger;
    const bus = createAgentEventBus(logger);

    const after = vi.fn();
    // The cast is what a real codebase often does for async listeners:
    // the `=> void` slot accepts an `async` arrow because Promise<void>
    // is structurally compatible.
    bus.subscribe((async () => {
      throw new Error("async-boom");
    }) as unknown as Parameters<typeof bus.subscribe>[0]);
    bus.subscribe(after);

    bus.publish(makeAgent("agt_x"));

    // Synchronous listener after the async-throwing one still ran on the
    // publishing thread, before the rejection materialised.
    expect(after).toHaveBeenCalledTimes(1);

    // Wait one microtask cycle for the async rejection to be observed
    // and forwarded to the logger.
    await Promise.resolve();
    await Promise.resolve();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[1]).toBe("Agent event listener threw");
  });

  it("publish() is synchronous (returns void, not Promise)", () => {
    const bus = createAgentEventBus(noopLogger);
    bus.subscribe(vi.fn());

    const result = bus.publish(makeAgent("agt_x"));
    // The bus is intentionally synchronous so the data-layer caller doesn't
    // have to await fanout. Listeners that need async work should kick off
    // their own promise.
    expect(result).toBeUndefined();
  });

  it("returns independent buses (each createAgentEventBus call has its own listener list)", () => {
    const a = createAgentEventBus(noopLogger);
    const b = createAgentEventBus(noopLogger);

    const aListener = vi.fn();
    const bListener = vi.fn();
    a.subscribe(aListener);
    b.subscribe(bListener);

    a.publish(makeAgent("agt_x"));

    expect(aListener).toHaveBeenCalledTimes(1);
    expect(bListener).not.toHaveBeenCalled();
  });

  it("subscribe() does not fire retroactively — listeners only see future publishes", () => {
    const bus = createAgentEventBus(noopLogger);
    bus.publish(makeAgent("agt_before"));

    const late = vi.fn();
    bus.subscribe(late);

    expect(late).not.toHaveBeenCalled();
  });
});
