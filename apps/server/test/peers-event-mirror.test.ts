import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { PeerEventSubscriber } from "../src/peers/events.js";
import { setupTestDb, teardownTestDb, runTestMigrations } from "./db/setup.js";

let pool: Pool;

const PEER_ID = "inst_mirror_src";
const REMOTE_ID = "agt_remote_1";
const SHADOW_ID = "agt_shadow_1";

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await pool.query("DELETE FROM agent_events WHERE agent_id = $1", [SHADOW_ID]);
  await pool.query("DELETE FROM agents WHERE id = $1", [SHADOW_ID]);
  await pool.query("DELETE FROM peers WHERE id = $1", [PEER_ID]);
  await pool.query(
    `INSERT INTO peers (id, name, url, outbound_token)
     VALUES ($1, 'Cloud', 'http://cloud.example:6767', 'tok')`,
    [PEER_ID]
  );
  await pool.query(
    `INSERT INTO agents (id, name, type, status, cwd, peer_id, remote_id)
     VALUES ($1, 'remote agent', 'claude', 'creating', '/tmp/repo', $2, $3)`,
    [SHADOW_ID, PEER_ID, REMOTE_ID]
  );
});

const log = {
  debug: () => {},
  warn: () => {},
  info: () => {},
  error: () => {},
} as never;

/**
 * Drive the subscriber against a scripted SSE body. Returns once the frames
 * have been consumed and the stream closed, so assertions see settled writes.
 */
async function mirror(frames: unknown[]): Promise<void> {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(frame)}\n\n`)
        );
      }
      controller.close();
    },
  });
  let resolveDone: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const subscriber = new PeerEventSubscriber({
    pool,
    agentManager: {
      getAgent: async () => null,
      listAgents: async () => [],
    } as never,
    publishUiEvent: () => {},
    withStreamFlag: ((agent: unknown) => agent) as never,
    log,
    fetchImpl: (async () => {
      // One connection's worth of frames; the reconnect after it resolves the
      // test rather than looping forever.
      queueMicrotask(() => setTimeout(() => resolveDone(), 50));
      return new Response(body, { status: 200 });
    }) as typeof fetch,
  });
  subscriber.start();
  await done;
  subscriber.stop();
  // The history append is fire-and-forget; let it land.
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function shadowRow() {
  const result = await pool.query(
    `SELECT status, name, latest_event_type, latest_event_message,
            latest_event_updated_at, latest_event_metadata
       FROM agents WHERE id = $1`,
    [SHADOW_ID]
  );
  return result.rows[0];
}

async function historyCount(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*) FROM agent_events WHERE agent_id = $1",
    [SHADOW_ID]
  );
  return Number(result.rows[0].count);
}

const AT = "2026-08-17T10:00:00.000Z";

function upsert(latestEvent: unknown, status = "running") {
  return {
    type: "agent.upsert",
    agent: {
      id: REMOTE_ID,
      name: "remote agent",
      type: "claude",
      status,
      latestEvent,
    },
  };
}

describe("mirroring remote events onto shadow rows", () => {
  it("writes the remote event onto the shadow and into its history", async () => {
    await mirror([
      upsert({
        type: "working",
        message: "Surveying the VM",
        updatedAt: AT,
        metadata: { source: "agent" },
      }),
    ]);

    const row = await shadowRow();
    expect(row.status).toBe("running");
    expect(row.latest_event_type).toBe("working");
    expect(row.latest_event_message).toBe("Surveying the VM");
    expect(new Date(row.latest_event_updated_at).toISOString()).toBe(AT);
    expect(row.latest_event_metadata).toMatchObject({ source: "agent" });
    expect(await historyCount()).toBe(1);
  });

  it("does not duplicate history when a snapshot replays the same event", async () => {
    const event = {
      type: "working",
      message: "Surveying the VM",
      updatedAt: AT,
      metadata: {},
    };
    await mirror([upsert(event)]);
    // A reconnect replays the whole agent list; the remote timestamp is the
    // dedupe identity, so the second pass must add nothing.
    await mirror([
      {
        type: "snapshot",
        agents: [{ id: REMOTE_ID, status: "running", latestEvent: event }],
      },
    ]);

    expect(await historyCount()).toBe(1);
  });

  it("appends a second row for a genuinely newer remote event", async () => {
    await mirror([
      upsert({
        type: "working",
        message: "First",
        updatedAt: AT,
        metadata: {},
      }),
    ]);
    await mirror([
      upsert({
        type: "blocked",
        message: "Second",
        updatedAt: "2026-08-17T10:05:00.000Z",
        metadata: {},
      }),
    ]);

    expect(await historyCount()).toBe(2);
    expect((await shadowRow()).latest_event_type).toBe("blocked");
  });

  it("leaves the shadow's own event alone when the peer does not share events", async () => {
    await pool.query(
      `UPDATE agents SET latest_event_type = 'idle',
                         latest_event_message = 'local stamp',
                         latest_event_updated_at = now()
        WHERE id = $1`,
      [SHADOW_ID]
    );
    // No latestEvent key at all — what a peer without allow_events sends.
    await mirror([
      {
        type: "agent.upsert",
        agent: { id: REMOTE_ID, name: "remote agent", status: "running" },
      },
    ]);

    const row = await shadowRow();
    expect(row.status).toBe("running");
    expect(row.latest_event_message).toBe("local stamp");
    expect(await historyCount()).toBe(0);
  });

  it("rejects a remote event with an unknown type or unparseable timestamp", async () => {
    await mirror([
      upsert({ type: "on_fire", message: "nope", updatedAt: AT, metadata: {} }),
    ]);
    await mirror([
      upsert({ type: "working", message: "nope", updatedAt: "not-a-date" }),
    ]);

    const row = await shadowRow();
    expect(row.latest_event_type).toBeNull();
    expect(await historyCount()).toBe(0);
  });
});
