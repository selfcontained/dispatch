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
import { setupTestDb, runTestMigrations, teardownTestDb } from "./db/setup.js";
import { RoutingSettings } from "../src/chat/routing-settings.js";
import {
  SteeringDecisions,
  steeringEvidence,
} from "../src/chat/steering-decisions.js";
import { BlockStore } from "../src/chat/store.js";
import { summarizeDecisions } from "../src/chat/decision-metrics.js";
import type { ClassifySteering } from "../src/agents/steering.js";

let pool: Pool;
let settings: RoutingSettings;
let blocks: BlockStore;
const agentId = "agt_steering";
const transport = vi.fn<typeof fetch>();
const response = (choice = "steer_current", confidence = 0.95) =>
  new Response(
    JSON.stringify({
      answers: [
        {
          type: "choice",
          name: "delivery",
          choice,
          confidence,
          probabilities: [{ value: choice, probability: confidence }],
        },
      ],
      usage: {
        input_tokens: 120,
        output_tokens: 0,
        total_tokens: 120,
        secret: "never retain",
      },
    })
  );
async function input(): Promise<Parameters<ClassifySteering>[0]> {
  const active = await blocks.insert({
    streamId: agentId,
    toAgentId: agentId,
    author: { kind: "user" },
    text: "Fix the parser",
  });
  const incoming = await blocks.insert({
    streamId: agentId,
    toAgentId: agentId,
    author: { kind: "user" },
    text: "Preserve version 1",
  });
  return {
    agentId,
    messageId: incoming.id,
    turnSeq: 1,
    activeMessageIds: [active.id],
    conversation: { streamId: agentId, threadId: null },
    defaultSteers: true,
    signal: new AbortController().signal,
  };
}
beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  await pool.query(
    "INSERT INTO agents(id,name,cwd,status) VALUES($1,'Steering','/tmp','running')",
    [agentId]
  );
});
afterAll(teardownTestDb);
beforeEach(async () => {
  await pool.query(
    "TRUNCATE steering_decision_records,steering_decision_daily"
  );
  await pool.query("DELETE FROM blocks");
  await pool.query("DELETE FROM settings");
  blocks = new BlockStore(pool);
  settings = new RoutingSettings(pool, {});
  transport.mockReset();
  transport.mockImplementation(async () => response());
});
const service = (env = {}) =>
  new SteeringDecisions(pool, settings, transport, env);
async function enable() {
  await settings.save({
    apiKey: "synthetic-test-token",
    steeringMode: "active",
  });
}

describe("steering decisions", () => {
  it("is off by default and shares a key with independently controlled reply routing", async () => {
    expect(await service().classify(await input())).toBeUndefined();
    expect(transport).not.toHaveBeenCalled();
    await enable();
    expect(await settings.status()).toMatchObject({
      mode: "off",
      steeringMode: "active",
      configured: true,
    });
    await settings.save({ removeKey: true });
    expect(await settings.status()).toMatchObject({
      mode: "off",
      steeringMode: "off",
      configured: false,
    });
  });
  it("sends bounded evidence and retains sanitized usage and the applied outcome", async () => {
    await enable();
    const data = await input();
    await blocks.update(data.messageId, { text: "Incoming private text" });
    const result = await service().classify(data);
    expect(result?.choice).toBe("steer_current");
    expect(result?.valid()).toBe(true);
    const body = JSON.parse(transport.mock.calls[0]![1]!.body as string);
    expect(body.questions[0].name).toBe("delivery");
    expect(JSON.parse(body.input)).toMatchObject({
      current_request: ["Fix the parser"],
      incoming_message: "Incoming private text",
    });
    expect(JSON.parse(body.input)).not.toHaveProperty("same_discussion");
    expect(JSON.parse(body.input)).not.toHaveProperty("default_delivery");
    result!.finish("steered");
    await vi.waitFor(async () => {
      const record = (
        await pool.query("SELECT result FROM steering_decision_records")
      ).rows[0].result;
      expect(record.outcome).toBe("steered");
      expect(JSON.stringify(record)).not.toContain("private text");
      expect(JSON.stringify(record)).not.toContain("never retain");
      expect(JSON.stringify(record)).not.toContain("synthetic-test-token");
    });
  });
  it("classifies follow-ups to the user's initial launch prompt", async () => {
    await enable();
    const data = await input();
    await pool.query("UPDATE blocks SET kind='launch' WHERE id=$1", [
      data.activeMessageIds[0],
    ]);
    const result = await service().classify(data);
    expect(result?.choice).toBe("steer_current");
    expect(transport).toHaveBeenCalledOnce();
  });
  it("invalidates in-flight results when the flag changes", async () => {
    await enable();
    const result = await service().classify(await input());
    await settings.save({ steeringMode: "off" });
    expect(result?.valid()).toBe(false);
  });
  it.each([
    { name: "steering is disabled", change: { steeringMode: "off" as const } },
    { name: "the token is removed", change: { removeKey: true } },
  ])(
    "does not send evidence after $name during a blocked reservation",
    async ({ change }) => {
      await enable();
      const data = await input();
      const locker = await pool.connect();
      await locker.query("BEGIN");
      await locker.query("SELECT pg_advisory_xact_lock(719394022)");
      const pending = service().classify(data);
      try {
        await vi.waitFor(
          async () => {
            const waiting = await pool.query(
              "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query='SELECT pg_advisory_xact_lock(719394022)'"
            );
            expect(waiting.rowCount).toBeGreaterThan(0);
          },
          { timeout: 4000 }
        );
        await settings.save(change);
        await locker.query("COMMIT");
        expect(await pending).toBeUndefined();
        expect(transport).not.toHaveBeenCalled();
        const rows = (
          await pool.query(
            "SELECT status,result FROM steering_decision_records"
          )
        ).rows;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          status: "skipped_config_changed",
          result: { selected: "keep_existing_default", outcome: "default" },
        });
        expect(rows[0].result).not.toHaveProperty("usage");
      } finally {
        await locker.query("ROLLBACK");
        locker.release();
        await pending;
      }
    }
  );
  it("keeps the default for low certainty and malformed responses", async () => {
    await enable();
    transport.mockImplementationOnce(async () => response("queue_next", 0.5));
    expect((await service().classify(await input()))?.choice).toBe(
      "keep_existing_default"
    );
    transport.mockImplementationOnce(async () => response("invented_action"));
    expect((await service().classify(await input()))?.choice).toBe(
      "keep_existing_default"
    );
    expect(
      (
        await pool.query(
          "SELECT status FROM steering_decision_records ORDER BY id DESC LIMIT 1"
        )
      ).rows[0].status
    ).toBe("malformed");
  });
  it("deduplicates and enforces the daily cap without additional API calls", async () => {
    await enable();
    const data = await input();
    const instance = service({ DISPATCH_STEERING_DAILY_CAP: "1" });
    await instance.classify(data);
    await instance.classify(data);
    await instance.classify(await input());
    expect(transport).toHaveBeenCalledOnce();
    expect(
      (
        await pool.query(
          "SELECT status FROM steering_decision_records ORDER BY id DESC LIMIT 1"
        )
      ).rows[0].status
    ).toBe("skipped_daily_cap");
  });
  it("rejects foreign-recipient context and cancels without making a request", async () => {
    await enable();
    const data = await input();
    await pool.query("UPDATE blocks SET to_agent_id='other' WHERE id=$1", [
      data.messageId,
    ]);
    expect(await steeringEvidence(pool, data)).toBeUndefined();
    const controller = new AbortController();
    controller.abort();
    expect(
      await service().classify({ ...data, signal: controller.signal })
    ).toBeUndefined();
    expect(transport).not.toHaveBeenCalled();
  });
  it("applies a UTF-8 byte budget even to non-ASCII evidence", async () => {
    const data = await input();
    for (const id of [data.messageId, ...data.activeMessageIds])
      await blocks.update(id, { text: "😀".repeat(5000) });
    const evidence = await steeringEvidence(pool, data);
    expect(Buffer.byteLength(evidence!, "utf8")).toBeLessThanOrEqual(8192);
    expect(JSON.parse(evidence!).incoming_message.length).toBeGreaterThan(0);
  });
});

it("separates actual actions, fallbacks, failures, skips and unknown costs", () => {
  const result = summarizeDecisions(
    [
      {
        status: "ok",
        result: {
          outcome: "steered",
          latencyMs: 100,
          usage: { input_tokens: 100 },
        },
      },
      {
        status: "ok",
        result: {
          outcome: "queued",
          latencyMs: 200,
          usage: { input_tokens: 100 },
        },
      },
      { status: "timeout", result: { outcome: "default", latencyMs: 300 } },
      { status: "skipped_daily_cap", result: {} },
    ],
    "steering"
  );
  expect(result).toMatchObject({
    attempts: 3,
    applied: 2,
    steered: 1,
    queued: 1,
    failures: 1,
    defaults: 1,
    skipped: 1,
    unknownCostCalls: 1,
    medianMs: 200,
    p95Ms: 300,
  });
});
