import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import {
  diffPins,
  PIN_UPDATE_COALESCE_SECONDS,
  recordPinEvents,
} from "../src/agents/pin-events.js";
import type { AgentPin } from "../src/agents/types.js";
import { composeChatFeed } from "../src/chat/feed.js";
import { ChatStore } from "../src/chat/store.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

const pin = (id: string, over: Partial<AgentPin> = {}): AgentPin => ({
  id,
  label: `Label ${id}`,
  value: `value ${id}`,
  type: "string",
  ...over,
});

describe("diffPins", () => {
  it("reports creates in after-order, then deletes in before-order", () => {
    const before = [pin("a"), pin("b"), pin("c")];
    const after = [pin("d"), pin("b"), pin("e")];
    expect(diffPins(before, after)).toEqual([
      { pinId: "d", label: "Label d", action: "created" },
      { pinId: "e", label: "Label e", action: "created" },
      { pinId: "a", label: "Label a", action: "deleted" },
      { pinId: "c", label: "Label c", action: "deleted" },
    ]);
  });

  it("reports an update only when a notable field changed", () => {
    const before = [pin("a"), pin("b"), pin("c"), pin("d"), pin("e")];
    const after = [
      pin("a", { value: "new" }),
      pin("b", { label: "Renamed" }),
      pin("c", { caption: "now with caption" }),
      pin("d", { group: "Build", icon: "rocket" }), // decoration only
      pin("e"), // unchanged
    ];
    expect(diffPins(before, after)).toEqual([
      { pinId: "a", label: "Label a", action: "updated" },
      { pinId: "b", label: "Renamed", action: "updated" },
      { pinId: "c", label: "Label c", action: "updated" },
    ]);
  });

  it("ignores pins without an id", () => {
    const legacy = { label: "old", value: "x", type: "string" } as AgentPin;
    expect(diffPins([legacy], [legacy, pin("a")])).toEqual([
      { pinId: "a", label: "Label a", action: "created" },
    ]);
  });
});

describe("recordPinEvents", () => {
  let pool: Pool;
  let store: ChatStore;
  const A = "agt_pin_events_a";

  beforeAll(async () => {
    pool = await setupTestDb();
    await runTestMigrations();
    store = new ChatStore(pool);
    await pool.query(
      `INSERT INTO agents (id, name, cwd, status) VALUES ($1, 'Pins', '/tmp', 'running')`,
      [A]
    );
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM pin_events");
  });

  const rows = () =>
    pool
      .query<{
        pin_id: string;
        label: string;
        action: string;
      }>(
        `SELECT pin_id, label, action FROM pin_events WHERE agent_id = $1 ORDER BY id`,
        [A]
      )
      .then((r) => r.rows);

  it("appends one row per event", async () => {
    await recordPinEvents(pool, A, [
      { pinId: "a", label: "A", action: "created" },
      { pinId: "b", label: "B", action: "updated" },
      { pinId: "c", label: "C", action: "deleted" },
    ]);
    expect(await rows()).toEqual([
      { pin_id: "a", label: "A", action: "created" },
      { pin_id: "b", label: "B", action: "updated" },
      { pin_id: "c", label: "C", action: "deleted" },
    ]);
  });

  it("folds a rapid second update into the previous update row", async () => {
    await recordPinEvents(pool, A, [
      { pinId: "a", label: "A", action: "created" },
    ]);
    await recordPinEvents(pool, A, [
      { pinId: "a", label: "A", action: "updated" },
    ]);
    const before = await pool.query<{ id: number; created_at: Date }>(
      `SELECT id, created_at FROM pin_events WHERE action = 'updated'`
    );
    // Age the log a little so the bump is observable, but keep the update
    // inside the coalesce window.
    await pool.query(
      `UPDATE pin_events SET created_at = created_at - interval '5 seconds'`
    );
    await recordPinEvents(pool, A, [
      { pinId: "a", label: "A renamed", action: "updated" },
    ]);
    const after = await pool.query<{ id: number; created_at: Date }>(
      `SELECT id, created_at FROM pin_events WHERE action = 'updated'`
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]!.id).toBe(before.rows[0]!.id);
    expect(after.rows[0]!.created_at.getTime()).toBeGreaterThanOrEqual(
      before.rows[0]!.created_at.getTime()
    );
    expect(await rows()).toEqual([
      { pin_id: "a", label: "A", action: "created" },
      { pin_id: "a", label: "A renamed", action: "updated" },
    ]);
  });

  it("does not fold across the coalesce window, a create, or another pin", async () => {
    await recordPinEvents(pool, A, [
      { pinId: "a", label: "A", action: "updated" },
      { pinId: "b", label: "B", action: "created" },
    ]);
    await pool.query(
      `UPDATE pin_events SET created_at = now() - make_interval(secs => $1)`,
      [PIN_UPDATE_COALESCE_SECONDS + 1]
    );
    await recordPinEvents(pool, A, [
      { pinId: "a", label: "A", action: "updated" }, // stale: new row
      { pinId: "b", label: "B", action: "updated" }, // previous is a create: new row
    ]);
    expect((await rows()).map((r) => `${r.pin_id}:${r.action}`)).toEqual([
      "a:updated",
      "b:created",
      "a:updated",
      "b:updated",
    ]);
  });

  it("surfaces one feed entry per write, grouping a batch", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await recordPinEvents(client, A, [
        { pinId: "a", label: "A", action: "created" },
        { pinId: "b", label: "B", action: "created" },
        { pinId: "c", label: "C", action: "deleted" },
      ]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    await recordPinEvents(pool, A, [
      { pinId: "a", label: "A", action: "updated" },
    ]);

    const feed = await composeChatFeed(store, A);
    const entries = feed.entries.filter((e) => e.type === "pin");
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => [e.action, e.pins])).toEqual([
      [
        "created",
        [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
      ],
      ["deleted", [{ id: "c", label: "C" }]],
      ["updated", [{ id: "a", label: "A" }]],
    ]);
    expect(entries[0]!.id).toMatch(/^pin:\d+$/);
  });

  it("pages through pin entries by cursor without loss", async () => {
    for (let i = 0; i < 5; i += 1) {
      await pool.query(
        `INSERT INTO pin_events (agent_id, pin_id, label, action, created_at)
         VALUES ($1, $2, $2, 'created', $3)`,
        [A, `p${i}`, new Date(Date.UTC(2026, 0, 1, 0, 0, i))]
      );
    }
    const { decodeFeedCursor } = await import("../src/chat/feed.js");
    const seen: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = await composeChatFeed(store, A, {
        limit: 2,
        cursor: cursor ? decodeFeedCursor(cursor) : null,
      });
      // Pages come newest-first, each ascending: prepend the whole page.
      seen.unshift(
        ...page.entries.flatMap((e) =>
          e.type === "pin" ? e.pins.map((p) => p.id) : []
        )
      );
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(["p0", "p1", "p2", "p3", "p4"]);
  });
});
