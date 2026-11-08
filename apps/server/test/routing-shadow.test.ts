import {
  estimateRoutingUsd,
  summarizeRouting,
} from "../src/chat/routing-metrics.js";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Pool } from "pg";
import Fastify from "fastify";
import { RoutingSettings } from "../src/chat/routing-settings.js";
import { StreamService } from "../src/chat/service.js";
import {
  RoutingShadow,
  RoutingShadowStore,
  routingShadowConfig,
  shadowEvidence,
  parseShadowResponse,
  type ShadowInput,
} from "../src/chat/routing-shadow.js";
import { registerRoutingShadowRoutes } from "../src/routes/routing-shadow.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";
let pool: Pool;
let svc: StreamService;
let store: RoutingShadowStore;
const A = "agt_shadow";
const enabled = { enabled: true, apiKey: "test-dedicated-key", dailyCap: 25 };
const answer = {
  answers: [
    {
      type: "choice",
      name: "destination",
      choice: "home_root",
      probabilities: [{ value: "home_root", probability: 0.9 }],
      confidence: 0.8,
    },
  ],
  usage: { input_tokens: 42, total_tokens: 42, secret: "not retained" },
};
const ok = () => new Response(JSON.stringify(answer));
const transport = vi.fn<typeof fetch>();
async function idle(check: () => Promise<boolean>) {
  await vi.waitFor(async () => expect(await check()).toBe(true), {
    timeout: 4000,
  });
}
async function input(text = "continue", thread = true): Promise<ShadowInput> {
  const root = {
    block: await svc.store.insert({
      streamId: A,
      toAgentId: A,
      author: { kind: "user" },
      text: "original discussion",
    }),
  };
  const message = thread
    ? {
        block: await svc.store.insert({
          streamId: A,
          toAgentId: A,
          author: { kind: "user" },
          text,
          threadId: root.block.id,
          replyTo: root.block.id,
        }),
      }
    : root;
  const event = await pool.query(
    `INSERT INTO agent_stream_events(agent_id,seq,kind,payload) VALUES ($1, nextval('routing_shadow_test_seq'), 'turn', '{}') RETURNING id, created_at`,
    [A]
  );
  const id = Number(event.rows[0].id);
  return {
    agentId: A,
    turnRow: {
      id,
      agentId: A,
      seq: id,
      kind: "turn",
      key: null,
      payload: {},
      createdAt: event.rows[0].created_at,
      updatedAt: event.rows[0].created_at,
    },
    prompt: {
      source: "chat",
      userMessage: true,
      chatMessageId: message.block.id,
    },
    placement: {
      streamId: A,
      threadId: thread ? root.block.id : null,
      replyTo: thread ? message.block.id : null,
    },
  };
}
async function records() {
  return (
    await pool.query("SELECT * FROM routing_shadow_records ORDER BY turn_id")
  ).rows;
}
async function finished(n = 1) {
  await idle(async () => {
    const rows = await records();
    return rows.length === n && rows.every((r) => r.status !== "pending");
  });
  return records();
}
beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  await pool.query(
    "INSERT INTO agents(id,name,cwd,status) VALUES ($1, 'Shadow', '/tmp', 'running')",
    [A]
  );
  await pool.query("CREATE SEQUENCE routing_shadow_test_seq");
});
afterAll(teardownTestDb);
beforeEach(async () => {
  await pool.query("TRUNCATE routing_shadow_records, routing_shadow_daily");
  await pool.query("DELETE FROM blocks");
  await pool.query(
    "DELETE FROM settings WHERE key IN ('routing_mode', 'routing_api_key')"
  );
  store = new RoutingShadowStore(pool);
  svc = new StreamService({
    pool,
    getAgent: async (id) => ({
      id,
      name: id,
      filesDir: null,
      status: "running",
    }),
    filesRoot: "/tmp",
    publishUiEvent: () => {},
  });
  transport.mockReset().mockImplementation(async () => ok());
});
describe("optional routing shadow", () => {
  it("requires both explicit opt-in and dedicated key; invalid caps fail closed", async () => {
    const event = await input();
    new RoutingShadow({ ...enabled, enabled: false }, store, transport).observe(
      event
    );
    new RoutingShadow({ ...enabled, apiKey: "" }, store, transport).observe(
      event
    );
    expect(transport).not.toHaveBeenCalled();
    expect(await records()).toEqual([]);
    expect(routingShadowConfig({ OPENAI_API_KEY: "ordinary-key" })).toEqual({
      enabled: false,
      apiKey: "",
      mode: "off",
      dailyCap: 25,
    });
    expect(
      routingShadowConfig({ DISPATCH_ROUTING_SHADOW_DAILY_CAP: "5000" })
        .dailyCap
    ).toBe(0);
  });
  it("observes the real turn-start path without delaying or changing frozen placement", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    transport.mockImplementation(async () => {
      await gate;
      return ok();
    });
    const observer = new RoutingShadow(enabled, store, transport);
    const service = new StreamService({
      pool,
      routingShadow: observer,
      getAgent: async () => null,
      filesRoot: "/tmp",
      publishUiEvent: () => {},
    });
    const event = await input();
    const blockId = await service.recordTurnStarted(event);
    expect(await service.store.getById(blockId!)).toMatchObject(
      event.placement
    );
    await idle(async () => transport.mock.calls.length === 1);
    const [url, options] = transport.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/decisions");
    const request = JSON.parse(options!.body as string);
    expect(request.model).toBe("gpt-6-luna");
    expect(request.questions[0]).toMatchObject({
      type: "choice",
      name: "destination",
    });
    expect(
      request.questions[0].choices.map((c: { value: string }) => c.value)
    ).toEqual(["initiating_discussion", "home_root", "keep_existing_default"]);
    expect(typeof request.input).toBe("string");
    release();
    const [record] = await finished();
    expect(record).toMatchObject({
      explicit_thread: true,
      status: "ok",
      result: {
        choice: "home_root",
        usage: { input_tokens: 42, total_tokens: 42 },
      },
    });
    expect(await service.store.getById(blockId!)).toMatchObject(
      event.placement
    );
    expect(JSON.stringify(record)).not.toContain("original discussion");
    expect(JSON.stringify(record)).not.toContain("test-dedicated-key");
  });
  it.each([
    ["malformed", () => new Response('{"answers":[]}')],
    ["refusal", () => new Response('{"answers":[{"type":"refusal"}]}')],
    [
      "provider_error",
      () => new Response("private provider body", { status: 429 }),
    ],
    [
      "error",
      () => {
        throw new Error("private transport error");
      },
    ],
    ["error", () => new Response("not json")],
    ["malformed", () => new Response("x".repeat(17000))],
  ] as const)(
    "contains %s without storing raw errors",
    async (status, response) => {
      transport.mockImplementation(async () => response());
      new RoutingShadow(enabled, store, transport).observe(await input());
      const [record] = await finished();
      expect(record.status).toBe(status);
      expect(JSON.stringify(record)).not.toContain("private");
    }
  );
  it("aborts a timed out request without retry", async () => {
    transport.mockImplementation(
      async (_url, init) =>
        new Promise((_r, reject) =>
          init!.signal!.addEventListener("abort", () =>
            reject(new Error("abort"))
          )
        )
    );
    new RoutingShadow(enabled, store, transport, 20).observe(await input());
    expect((await finished())[0].status).toBe("timeout");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("bounds evidence and excludes internal, structured, foreign, and attachment content", async () => {
    const event = await input("x".repeat(20000));
    const evidence = await shadowEvidence(pool, event);
    expect(evidence!.input.length).toBeLessThan(6500);
    expect(JSON.parse(evidence!.input).incoming[0]).toHaveLength(1000);
    for (let i = 0; i < 5; i++) {
      const nearby = await svc.store.insert({
        streamId: A,
        toAgentId: A,
        author: { kind: "user" },
        text: "nearby".repeat(300),
        threadId: event.placement.threadId,
        replyTo: event.placement.threadId,
      });
      await pool.query(
        "UPDATE blocks SET created_at = now() - interval '1 minute' WHERE id = $1",
        [nearby.id]
      );
    }
    const bounded = JSON.parse((await shadowEvidence(pool, event))!.input);
    expect(bounded.nearby).toHaveLength(3);
    expect(
      bounded.nearby.every(
        (entry: { text: string }) => entry.text.length === 500
      )
    ).toBe(true);
    const id = event.prompt.source === "chat" ? event.prompt.chatMessageId : "";
    await pool.query(
      `UPDATE blocks SET attachments = '[{"type":"file","caption":"private attachment"}]' WHERE id = $1`,
      [id]
    );
    expect((await shadowEvidence(pool, event))!.input).not.toContain(
      "private attachment"
    );
    expect((await shadowEvidence(pool, event))!.input).not.toContain("xxxxx");
    await pool.query(
      "UPDATE blocks SET to_agent_id = 'someone-else' WHERE id = $1",
      [id]
    );
    expect(await shadowEvidence(pool, event)).toBeNull();
    expect(
      await shadowEvidence(pool, {
        ...event,
        prompt: { source: "system", text: "system" },
      })
    ).toBeNull();
    expect(
      await shadowEvidence(pool, {
        ...event,
        prompt: { ...event.prompt, awaited: true },
      })
    ).toBeNull();
    const question = await svc.store.insert({
      streamId: A,
      kind: "question",
      author: { kind: "agent", agentId: A },
      text: "ask",
    });
    await pool.query(
      "UPDATE blocks SET to_agent_id = $2, reply_to = $3 WHERE id = $1",
      [id, A, question.id]
    );
    expect(await shadowEvidence(pool, event)).toBeNull();
  });
  it("deduplicates across observers/restarts and persists the daily call cap", async () => {
    const one = await input();
    const two = await input();
    const first = new RoutingShadow(
      { ...enabled, dailyCap: 1 },
      store,
      transport
    );
    first.observe(one);
    await finished();
    const restarted = new RoutingShadow(
      { ...enabled, dailyCap: 1 },
      new RoutingShadowStore(pool),
      transport
    );
    restarted.observe(one);
    restarted.observe(two);
    const rows = await finished(2);
    expect(rows.map((r) => r.status)).toEqual(["ok", "skipped_daily_cap"]);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(
      (await pool.query("SELECT calls FROM routing_shadow_daily")).rows[0].calls
    ).toBe(1);
    await pool.query("DELETE FROM routing_shadow_records");
    restarted.observe(one);
    await new Promise((r) => setTimeout(r, 50));
    expect(await records()).toHaveLength(0);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("reserves at most two concurrent calls across instances", async () => {
    const events = await Promise.all([input(), input(), input()]);
    const evidence = await Promise.all(
      events.map((e) => shadowEvidence(pool, e))
    );
    const results = await Promise.all(
      events.map((e, i) =>
        new RoutingShadowStore(pool).reserve(e, evidence[i]!, 25)
      )
    );
    expect(results.filter((r) => r === "pending")).toHaveLength(2);
    expect(results.filter((r) => r === "skipped_concurrency")).toHaveLength(1);
  });
  it("exports only with authentication and validates cursors", async () => {
    const app = Fastify();
    await registerRoutingShadowRoutes(app, store, "secret");
    expect(
      (await app.inject({ url: "/api/v1/experiments/routing-shadow" }))
        .statusCode
    ).toBe(401);
    const headers = { authorization: "Bearer secret" };
    expect(
      (
        await app.inject({
          url: "/api/v1/experiments/routing-shadow?before=no",
          headers,
        })
      ).statusCode
    ).toBe(400);
    new RoutingShadow(enabled, store, transport).observe(await input());
    await finished();
    const response = await app.inject({
      url: "/api/v1/experiments/routing-shadow?format=jsonl",
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(response.body.trim()).result.choice).toBe("home_root");
    await app.close();
  });
  it("enforces the byte bound for escaped text and prunes expired diagnostics without resetting budget", async () => {
    const event = await input("\u0001".repeat(4000));
    const evidence = await shadowEvidence(pool, event);
    expect(Buffer.byteLength(evidence!.input, "utf8")).toBeLessThanOrEqual(
      8192
    );
    new RoutingShadow(enabled, store, transport).observe(event);
    await finished();
    await pool.query(
      "UPDATE routing_shadow_records SET status = 'pending', created_at = now() - interval '11 seconds'"
    );
    await store.prune();
    expect((await records())[0].status).toBe("interrupted");
    await pool.query(
      "UPDATE routing_shadow_records SET created_at = now() - interval '15 days'"
    );
    expect(await store.read()).toEqual([]);
    expect(
      (await pool.query("SELECT calls FROM routing_shadow_daily")).rows[0].calls
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT routing_shadow_observed FROM agent_stream_events WHERE id = $1",
          [event.turnRow.id]
        )
      ).rows[0].routing_shadow_observed
    ).toBe(true);
  });
  it("applies a confident active decision to a validated root-post discussion before first output", async () => {
    const event = await input("explain", false);
    transport.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            answers: [
              {
                type: "choice",
                name: "destination",
                choice: "initiating_discussion",
                probabilities: [
                  { value: "initiating_discussion", probability: 0.95 },
                ],
                confidence: 0.95,
              },
            ],
          })
        )
    );
    const experiment = new RoutingShadow(
      { ...enabled, mode: "active" },
      store,
      transport
    );
    const service = new StreamService({
      pool,
      routingShadow: experiment,
      getAgent: async () => null,
      filesRoot: "/tmp",
      publishUiEvent: () => {},
    });
    const id = await service.recordTurnStarted(event);
    const messageId =
      event.prompt.source === "chat" ? event.prompt.chatMessageId : "";
    expect(await service.store.getById(id!)).toMatchObject({
      streamId: A,
      threadId: messageId,
      replyTo: messageId,
    });
    await idle(async () => (await records())[0]?.result.applied === true);
    expect((await finished())[0].result).toMatchObject({
      mode: "active",
      applied: true,
    });
  });
  it("keeps explicit threads and uncertain active choices in their existing placement", async () => {
    const event = await input();
    const experiment = new RoutingShadow(
      { ...enabled, mode: "active" },
      store,
      transport
    );
    expect(await experiment.route(event)).toBeUndefined();
    expect((await finished())[0].result.applied).toBe(false);
    const root = await input("explain", false);
    transport.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            answers: [{ ...answer.answers[0], confidence: 0.2 }],
          })
        )
    );
    expect(await experiment.route(root)).toBeUndefined();
    expect((await finished(2))[1].result.applied).toBe(false);
  });
  it("bounds the whole active path and ignores a late provider response", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    transport.mockImplementation(async () => {
      await gate;
      return ok();
    });
    const event = await input("explain", false);
    const experiment = new RoutingShadow(
      { ...enabled, mode: "active" },
      store,
      transport,
      40
    );
    const original = { ...event.placement };
    expect(await experiment.route(event)).toBeUndefined();
    experiment.frozen(event.turnRow.id, original);
    release();
    await finished();
    await idle(async () => !!(await records())[0].result.actualPlacement);
    expect(event.placement).toEqual(original);
    expect((await records())[0].status).toBe("timeout");
    expect((await records())[0].result).toMatchObject({
      mode: "active",
      actualPlacement: original,
      applied: false,
      totalRoutingDelayMs: expect.any(Number),
    });
    expect((await store.summary()).activeRouting.n).toBe(1);
    transport.mockClear();
    const delayedSettings = new RoutingShadow(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { ...enabled, mode: "active" };
      },
      store,
      transport,
      10
    );
    expect(await delayedSettings.route(await input())).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(transport).not.toHaveBeenCalled();
  });
  it("keeps elapsed and frozen metadata when cancellation finishes before the provider", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    transport.mockImplementation(async () => {
      await gate;
      return ok();
    });
    const event = await input("explain", false);
    const experiment = new RoutingShadow(
      { ...enabled, mode: "active" },
      store,
      transport
    );
    const routing = experiment.route(event);
    await idle(async () => transport.mock.calls.length === 1);
    experiment.cancel(event.agentId);
    expect(await routing).toBeUndefined();
    experiment.frozen(event.turnRow.id, event.placement);
    release();
    await finished();
    await idle(async () => !!(await records())[0].result.actualPlacement);
    expect((await records())[0]).toMatchObject({
      status: "timeout",
      result: {
        mode: "active",
        applied: false,
        actualPlacement: event.placement,
        totalRoutingDelayMs: expect.any(Number),
      },
    });
    expect((await store.summary()).activeRouting.n).toBe(1);
  });
  it("retains fallback diagnostics when reservation completes after the deadline", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reserve = store.reserve.bind(store);
    const waiting = vi
      .spyOn(store, "reserve")
      .mockImplementation(async (...args) => {
        await gate;
        return reserve(...args);
      });
    const event = await input("explain", false);
    const experiment = new RoutingShadow(
      { ...enabled, mode: "active" },
      store,
      transport,
      100
    );
    const routing = experiment.route(event);
    await idle(async () => waiting.mock.calls.length === 1);
    expect(await routing).toBeUndefined();
    experiment.frozen(event.turnRow.id, event.placement);
    release();
    await finished();
    expect((await records())[0]).toMatchObject({
      status: "timeout",
      result: {
        mode: "active",
        actualPlacement: event.placement,
        totalRoutingDelayMs: expect.any(Number),
      },
    });
    expect((await store.summary()).activeRouting.n).toBe(1);
    expect(transport).not.toHaveBeenCalled();
  });
  it("persists masked product settings and gives environment overrides precedence", async () => {
    const settings = new RoutingSettings(pool, {});
    expect(await settings.status()).toMatchObject({
      mode: "off",
      configured: false,
    });
    await settings.save({ mode: "active", apiKey: "test-first-secret" });
    expect(await new RoutingSettings(pool, {}).configuration()).toMatchObject({
      mode: "active",
      apiKey: "test-first-secret",
      enabled: true,
    });
    await settings.save({ apiKey: "test-replacement-secret" });
    expect(JSON.stringify(await settings.status())).not.toContain("secret");
    const override = new RoutingSettings(pool, {
      DISPATCH_DECISIONS_API_KEY: "environment-secret",
      DISPATCH_ROUTING_MODE: "off",
    });
    expect(await override.configuration()).toMatchObject({
      enabled: false,
      mode: "off",
      apiKey: "environment-secret",
    });
    await settings.save({ removeKey: true, mode: "shadow" });
    expect(await new RoutingSettings(pool, {}).configuration()).toMatchObject({
      apiKey: "",
      enabled: true,
    });
  });
  it.each(["invalid", ""])(
    "keeps an explicit invalid mode %j off despite legacy opt-in",
    async (mode) => {
      const settings = new RoutingSettings(pool, {
        DISPATCH_ROUTING_MODE: mode,
        DISPATCH_ROUTING_SHADOW_ENABLED: "1",
        DISPATCH_DECISIONS_API_KEY: "test-configured-secret",
      });
      expect(await settings.configuration()).toMatchObject({
        mode: "off",
        enabled: false,
      });
      expect(await settings.status()).toMatchObject({
        mode: "off",
        modeSource: "environment",
      });
      expect(
        await new RoutingSettings(pool, {
          DISPATCH_ROUTING_SHADOW_ENABLED: "1",
          DISPATCH_DECISIONS_API_KEY: "test-configured-secret",
        }).configuration()
      ).toMatchObject({ mode: "shadow", enabled: true });
    }
  );
  it("checks a synthetic connection while off using the shared persistent request cap", async () => {
    const settings = new RoutingSettings(pool, {});
    await settings.save({ mode: "off", apiKey: "synthetic-secret" });
    const experiment = new RoutingShadow(
      () => settings.configuration(),
      store,
      transport
    );
    expect((await experiment.checkConnection()).status).toBe("ok");
    expect((await settings.status()).mode).toBe("off");
    expect((await records())[0].agent_id).toBe("synthetic_connection_check");
    const request = JSON.parse(transport.mock.calls[0]![1]!.body as string);
    expect(request.input).not.toContain("original discussion");
    const capped = new RoutingShadow(
      { ...enabled, dailyCap: 1 },
      store,
      transport
    );
    expect((await capped.checkConnection()).status).toBe("skipped_daily_cap");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("serves settings without secret readback and rejects invalid secret payloads", async () => {
    const app = Fastify();
    const settings = new RoutingSettings(pool, {});
    const experiment = new RoutingShadow(
      () => settings.configuration(),
      store,
      transport
    );
    await registerRoutingShadowRoutes(
      app,
      store,
      "secret",
      settings,
      experiment,
      async () => true
    );
    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/experiments/routing/settings",
      payload: { mode: "shadow", apiKey: "secret-product-key" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain("secret-product-key");
    const read = await app.inject({
      url: "/api/v1/experiments/routing/settings",
    });
    expect(read.json()).toMatchObject({
      mode: "shadow",
      configured: true,
      storedKey: true,
    });
    expect(read.body).not.toContain("secret-product-key");
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/experiments/routing/settings",
          payload: { apiKey: "invalid\nsecret" },
        })
      ).statusCode
    ).toBe(400);
    await app.close();
  });
  it("estimates cost without double-counting cache tokens and leaves missing usage unknown", () => {
    const usage = {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 },
    };
    expect(estimateRoutingUsd(usage)).toBeCloseTo(0.0000845, 10);
    expect(estimateRoutingUsd({ input_tokens: 1000 })).toBeNull();
    const parsed = parseShadowResponse({
      ...answer,
      usage: {
        ...usage,
        input_tokens_details: {
          ...usage.input_tokens_details,
          private: "drop",
        },
      },
    });
    expect(parsed.usage.input_tokens_details).toEqual(
      usage.input_tokens_details
    );
    const summary = summarizeRouting([
      { status: "ok", result: { latencyMs: 100, usage } },
      { status: "timeout", result: { latencyMs: 3000 } },
    ]);
    expect(summary.provider).toEqual({
      n: 2,
      medianMs: 1550,
      p95Ms: 3000,
      maxMs: 3000,
    });
    expect(summary.estimatedUsd).toBeNull();
    expect(summary.unknownCostCalls).toBe(1);
    expect(summary.knownEstimatedUsd).toBeCloseTo(0.0000845, 10);
  });
  it("rejects anonymous settings and paid checks even in first-run mode", async () => {
    const app = Fastify();
    const settings = new RoutingSettings(pool, {});
    await registerRoutingShadowRoutes(
      app,
      store,
      "secret",
      settings,
      new RoutingShadow(enabled, store, transport)
    );
    for (const [method, url, payload] of [
      ["GET", "/api/v1/experiments/routing/settings", undefined],
      [
        "PUT",
        "/api/v1/experiments/routing/settings",
        { apiKey: "never-saved-key" },
      ],
      ["POST", "/api/v1/experiments/routing/check", undefined],
    ] as const) {
      expect((await app.inject({ method, url, payload })).statusCode).toBe(403);
    }
    expect(transport).not.toHaveBeenCalled();
    expect((await settings.status()).configured).toBe(false);
    await app.close();
  });
  it("exposes scoped active pending state and clears it on cancellation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    transport.mockImplementation(async () => {
      await gate;
      return ok();
    });
    const experiment = new RoutingShadow(
      { ...enabled, mode: "active" },
      store,
      transport
    );
    const task = experiment.route(await input("follow up", false));
    await idle(async () => transport.mock.calls.length > 0);
    expect(experiment.pending(A)[0]).toMatchObject({
      streamId: A,
      threadId: null,
      startedAt: expect.any(Number),
    });
    expect(experiment.pending("other-stream")).toEqual([]);
    experiment.cancel(A);
    expect(await task).toBeUndefined();
    expect(experiment.pending(A)).toEqual([]);
    release();
    await finished();
    expect((await records())[0].result.applied).toBe(false);
  });
  it("cancels only the settled turn while a newer routing attempt remains active", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    transport.mockImplementation(async () => {
      await gate;
      return ok();
    });
    const first = await input("first", false);
    const second = await input("second", false);
    const experiment = new RoutingShadow(
      { ...enabled, mode: "active" },
      store,
      transport
    );
    const firstTask = experiment.route(first);
    const secondTask = experiment.route(second);
    try {
      await idle(async () => transport.mock.calls.length === 2);
      experiment.cancel(A, first.turnRow.id);
      expect(await firstTask).toBeUndefined();
      expect(experiment.pending(A)).toEqual([
        expect.objectContaining({ turnId: second.turnRow.id }),
      ]);
    } finally {
      release();
    }
    await secondTask;
    const rows = await finished(2);
    expect(
      rows.find((r) => Number(r.turn_id) === first.turnRow.id).status
    ).toBe("timeout");
    expect(
      rows.find((r) => Number(r.turn_id) === second.turnRow.id).status
    ).toBe("ok");
  });
  it("rejects invalid probabilities and discards unknown provider fields", () => {
    expect(() =>
      parseShadowResponse({
        answers: [
          {
            ...answer.answers[0],
            probabilities: [{ value: "home_root", probability: 2 }],
          },
        ],
      })
    ).toThrow();
    expect(parseShadowResponse(answer).usage).not.toHaveProperty("secret");
  });
});
