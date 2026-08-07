import { EventEmitter } from "node:events";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerAgentEventRoutes } from "../src/routes/agents/events-routes.js";
import { UiEventBroker } from "../src/server/ui-events.js";

type EventHandler = (request: any, reply: any) => Promise<void>;

function createRouteHarness(listAgents: () => Promise<any[]>) {
  const get = vi.fn();
  const app = { get, post: vi.fn() } as unknown as FastifyInstance;
  const broker = new UiEventBroker();
  const sendUiSnapshot = vi.fn((stream, agents) =>
    broker.sendSnapshot(stream, agents)
  );

  return registerAgentEventRoutes(app, {
    agentManager: { listAgents },
    appLog: { warn: vi.fn() },
    subscribeUiEvents: (stream) => broker.subscribe(stream),
    sendUiSnapshot,
    withStreamFlag: (agent) => ({ ...agent, hasStream: false }),
  } as any).then(() => ({
    broker,
    sendUiSnapshot,
    handler: get.mock.calls[0][1] as EventHandler,
  }));
}

function createRequest() {
  const raw = new EventEmitter() as EventEmitter & { destroyed: boolean };
  raw.destroyed = false;
  return { raw };
}

function createReply() {
  const raw = Object.assign(new EventEmitter(), {
    setHeader: vi.fn(),
    write: vi.fn(),
  });
  return { raw, hijack: vi.fn() };
}

afterEach(() => vi.useRealTimers());

describe("GET /api/v1/events", () => {
  it("removes a client that disconnects after its snapshot", async () => {
    vi.useFakeTimers();
    const harness = await createRouteHarness(async () => []);
    const request = createRequest();
    const reply = createReply();

    await harness.handler(request, reply);
    expect(harness.sendUiSnapshot).toHaveBeenCalledOnce();
    expect(harness.broker.getMetrics().clients).toBe(1);

    request.raw.destroyed = true;
    request.raw.emit("close");

    expect(harness.broker.getMetrics().clients).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes a client that disconnects during snapshot loading", async () => {
    vi.useFakeTimers();
    let resolveAgents: (agents: any[]) => void;
    const agents = new Promise<any[]>((resolve) => {
      resolveAgents = resolve;
    });
    const harness = await createRouteHarness(() => agents);
    const request = createRequest();
    const reply = createReply();

    const response = harness.handler(request, reply);
    expect(harness.broker.getMetrics().clients).toBe(1);

    request.raw.destroyed = true;
    request.raw.emit("aborted");
    resolveAgents!([]);
    await response;

    expect(harness.sendUiSnapshot).not.toHaveBeenCalled();
    expect(harness.broker.getMetrics().clients).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
