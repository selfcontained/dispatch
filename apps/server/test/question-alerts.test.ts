import { randomUUID } from "node:crypto";
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
import { QuestionAlerts } from "../src/notifications/question-alerts.js";
import {
  SlackDeliveryUnknownError,
  SlackRetryError,
} from "../src/notifications/slack-app.js";
let pool: Pool;
beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});
afterAll(teardownTestDb);
beforeEach(async () => {
  await pool.query("DELETE FROM question_notifications");
  await pool.query("DELETE FROM blocks");
});
async function question(
  age: number,
  state: unknown = null,
  recipient: string | null = null
) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO blocks(id,stream_id,author_kind,author_agent_id,to_agent_id,kind,text,state,created_at)
    VALUES($1,'agt_stopped','agent','agt_stopped',$2,'question','Which option?',$3,now()-($4*interval '1 minute'))`,
    [id, recipient, state ? JSON.stringify(state) : null, age]
  );
  return id;
}
it("waits five minutes, ignores passive read state, and survives scanner restart without duplicate delivery", async () => {
  const id = await question(4);
  const send = vi.fn(async () => true);
  await new QuestionAlerts(pool, send, async () => ({
    generation: "test",
    enabledAt: "2000-01-01T00:00:00Z",
  })).tick();
  expect(send).not.toHaveBeenCalled();
  await pool.query(
    "UPDATE blocks SET created_at=now()-interval '6 minutes',read_at=now() WHERE id=$1",
    [id]
  );
  await pool.query(
    "UPDATE question_notifications SET next_attempt_at=now(),due_at=now() WHERE block_id=$1",
    [id]
  );
  await new QuestionAlerts(pool, send, async () => ({
    generation: "test",
    enabledAt: "2000-01-01T00:00:00Z",
  })).tick();
  await new QuestionAlerts(pool, send, async () => ({
    generation: "test",
    enabledAt: "2000-01-01T00:00:00Z",
  })).tick();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![0]).toMatchObject({
    agent_id: "agt_stopped",
    block_id: id,
  });
});
it("cancels answered questions and does not alert agent-directed inputs", async () => {
  await question(6, { answer: { value: "done" } });
  await question(6, null, "agt_parent");
  const send = vi.fn(async () => true);
  await new QuestionAlerts(pool, send, async () => ({
    generation: "test",
    enabledAt: "2000-01-01T00:00:00Z",
  })).tick();
  expect(send).not.toHaveBeenCalled();
});
it("retries a failed delivery after persisted backoff and recovers expired leases", async () => {
  const id = await question(6);
  const send = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(true);
  await new QuestionAlerts(pool, send, async () => ({
    generation: "test",
    enabledAt: "2000-01-01T00:00:00Z",
  })).tick();
  await new QuestionAlerts(pool, send, async () => ({
    generation: "test",
    enabledAt: "2000-01-01T00:00:00Z",
  })).tick();
  expect(send).toHaveBeenCalledTimes(1);
  await pool.query(
    "UPDATE question_notifications SET next_attempt_at=now(),lease_until=now()-interval '1 second' WHERE block_id=$1",
    [id]
  );
  await new QuestionAlerts(pool, send, async () => ({
    generation: "test",
    enabledAt: "2000-01-01T00:00:00Z",
  })).tick();
  expect(send).toHaveBeenCalledTimes(2);
  expect(
    (
      await pool.query(
        "SELECT sent_at FROM question_notifications WHERE block_id=$1",
        [id]
      )
    ).rows[0].sent_at
  ).toBeTruthy();
});
it("concurrent scanners claim an input once", async () => {
  await question(6);
  const send = vi.fn(async () => true);
  await Promise.all([
    new QuestionAlerts(pool, send, async () => ({
      generation: "test",
      enabledAt: "2000-01-01T00:00:00Z",
    })).tick(),
    new QuestionAlerts(pool, send, async () => ({
      generation: "test",
      enabledAt: "2000-01-01T00:00:00Z",
    })).tick(),
  ]);
  expect(send).toHaveBeenCalledTimes(1);
});

it("does not enroll old questions or accumulate attempts while disabled", async () => {
  await question(6);
  const send = vi.fn(async () => true);
  await new QuestionAlerts(pool, send, async () => null).tick();
  expect(
    (await pool.query("SELECT * FROM question_notifications")).rowCount
  ).toBe(0);
  await new QuestionAlerts(pool, send, async () => ({
    generation: "new",
    enabledAt: new Date().toISOString(),
  })).tick();
  expect(send).not.toHaveBeenCalled();
  expect(
    (await pool.query("SELECT * FROM question_notifications")).rowCount
  ).toBe(0);
});

it("alerts failed-parent questions that surfaced to the human", async () => {
  const id = await question(6, null, "agt_parent");
  await pool.query(
    "UPDATE blocks SET data='{\"parentHandled\":true}',delivered=false WHERE id=$1",
    [id]
  );
  const send = vi.fn(async () => true);
  await new QuestionAlerts(pool, send, async () => ({
    generation: "test",
    enabledAt: "2000-01-01T00:00:00Z",
  })).tick();
  expect(send).toHaveBeenCalledTimes(1);
});

describe("sendNow (notify with a form)", () => {
  const live = async () => ({
    generation: "test",
    enabledAt: "2000-01-01T00:00:00Z",
  });
  async function form(age = 0, recipient: string | null = null) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO blocks(id,stream_id,author_kind,author_agent_id,to_agent_id,kind,text,data,created_at)
      VALUES($1,'agt_stopped','agent','agt_stopped',$2,'form','Release details','{"fields":[{"id":"v","label":"Version","type":"text"}]}',now()-($3*interval '1 minute'))`,
      [id, recipient, age]
    );
    return id;
  }
  const row = async (id: string) =>
    (
      await pool.query(
        "SELECT *, next_attempt_at>now() AS later FROM question_notifications WHERE block_id=$1",
        [id]
      )
    ).rows[0];

  it("sends an explicit form at once, marks it immediate, and the worker never sends it again", async () => {
    const passive = await form();
    const explicit = await form();
    const send = vi.fn(async () => ({ channelId: "C1", timestamp: "1.0" }));
    const alerts = new QuestionAlerts(pool, send, live);
    expect(await alerts.sendNow(explicit)).toEqual({ delivery: "sent" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({
      block_id: explicit,
      immediate: true,
      kind: "form",
    });
    expect(await row(explicit)).toMatchObject({
      immediate: true,
      slack_message_ts: "1.0",
    });
    expect((await row(explicit)).sent_at).toBeTruthy();
    // The ordinary reminder for the passive form still waits five minutes.
    await alerts.tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(await row(passive)).toMatchObject({ immediate: false });
    expect((await row(passive)).later).toBe(true);
    // A repeat request reports the recorded success instead of resending.
    expect(await alerts.sendNow(explicit)).toEqual({ delivery: "sent" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("takes over a passive reminder row that was still waiting", async () => {
    const id = await form();
    const send = vi.fn(async () => true);
    const alerts = new QuestionAlerts(pool, send, live);
    await alerts.tick(); // enrolls the 5-minute reminder
    expect(send).not.toHaveBeenCalled();
    expect(await alerts.sendNow(id)).toEqual({ delivery: "sent" });
    expect(send).toHaveBeenCalledTimes(1);
    await pool.query(
      "UPDATE question_notifications SET next_attempt_at=now()-interval '1 second' WHERE block_id=$1",
      [id]
    );
    await alerts.tick();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("never double-sends against a worker holding the lease or a concurrent tick", async () => {
    const leased = await form(6);
    await pool.query(
      `INSERT INTO question_notifications(block_id,binding_generation,due_at,next_attempt_at,attempts,lease_until)
       VALUES($1,'test',now(),now(),1,now()+interval '60 seconds')`,
      [leased]
    );
    const send = vi.fn(async () => true);
    const outcome = await new QuestionAlerts(pool, send, live).sendNow(leased);
    expect(outcome.delivery).toBe("retrying");
    expect(send).not.toHaveBeenCalled();

    const due = await form(6);
    await Promise.all([
      new QuestionAlerts(pool, send, live).tick(),
      new QuestionAlerts(pool, send, live).sendNow(due),
    ]);
    expect(send.mock.calls.filter(([a]) => a.block_id === due)).toHaveLength(1);
  });

  it("keeps a failed send queued for the worker's retry and reports it honestly", async () => {
    const id = await form();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(true);
    const alerts = new QuestionAlerts(pool, send, live);
    const outcome = await alerts.sendNow(id);
    expect(outcome.delivery).toBe("retrying");
    expect(await row(id)).toMatchObject({ sent_at: null, lease_until: null });
    expect((await row(id)).later).toBe(true);
    await alerts.tick(); // backoff not elapsed
    expect(send).toHaveBeenCalledTimes(1);
    await pool.query(
      "UPDATE question_notifications SET next_attempt_at=now() WHERE block_id=$1",
      [id]
    );
    await alerts.tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0]).toMatchObject({ immediate: true });
    expect((await row(id)).sent_at).toBeTruthy();
  });

  it("honors Slack's retry-after and reports an unclear response as unknown", async () => {
    const limited = await form();
    const unclear = await form();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new SlackRetryError(600_000))
      .mockRejectedValueOnce(new SlackDeliveryUnknownError("timeout"));
    const alerts = new QuestionAlerts(pool, send, live);
    expect((await alerts.sendNow(limited)).delivery).toBe("retrying");
    const wait = await pool.query(
      "SELECT next_attempt_at > now()+interval '9 minutes' AS honored FROM question_notifications WHERE block_id=$1",
      [limited]
    );
    expect(wait.rows[0].honored).toBe(true);
    const outcome = await alerts.sendNow(unclear);
    expect(outcome.delivery).toBe("unknown");
    expect((await row(unclear)).sent_at).toBeNull();
    // Possibly already in the channel: the worker must not post a duplicate.
    expect((await row(unclear)).cancelled_at).toBeTruthy();
    await pool.query(
      "UPDATE question_notifications SET next_attempt_at=now() WHERE block_id=$1",
      [unclear]
    );
    send.mockResolvedValue(true);
    await alerts.tick();
    expect(
      send.mock.calls.filter(([a]) => a.block_id === unclear)
    ).toHaveLength(1);
  });

  it("reports not_sent for a changed Slack binding, answered/withdrawn or agent-directed forms", async () => {
    const stale = await form();
    const send = vi.fn(async () => false); // postAsk: binding generation moved
    const alerts = new QuestionAlerts(pool, send, live);
    expect((await alerts.sendNow(stale)).delivery).toBe("not_sent");
    expect((await row(stale)).sent_at).toBeNull();
    // The new binding's worker never sends the old generation's row.
    send.mockClear();
    await pool.query(
      "UPDATE question_notifications SET next_attempt_at=now() WHERE block_id=$1",
      [stale]
    );
    await new QuestionAlerts(pool, send, async () => ({
      generation: "other",
      enabledAt: new Date().toISOString(),
    })).tick();
    expect(send).not.toHaveBeenCalled();

    const answered = await form();
    await pool.query(
      `UPDATE blocks SET state='{"submission":{"values":{}}}' WHERE id=$1`,
      [answered]
    );
    const cancelled = await form();
    await pool.query(
      `UPDATE blocks SET state='{"cancellation":true}' WHERE id=$1`,
      [cancelled]
    );
    const directed = await form(0, "agt_parent");
    for (const id of [answered, cancelled, directed])
      expect((await alerts.sendNow(id)).delivery).toBe("not_sent");
    expect(send).not.toHaveBeenCalled();
  });

  it("a lost success record after Slack accepted reports sent and never lets the worker repost", async () => {
    const id = await form();
    const send = vi.fn(async () => ({ channelId: "C1", timestamp: "9.0" }));
    const flaky = {
      query: (sql: string, params?: unknown[]) =>
        /sent_at=CASE/.test(sql)
          ? Promise.reject(new Error("db blip"))
          : pool.query(sql, params as never),
    } as unknown as Pool;
    expect(await new QuestionAlerts(flaky, send, live).sendNow(id)).toEqual({
      delivery: "sent",
    });
    expect((await row(id)).cancelled_at).toBeTruthy();
    await pool.query(
      "UPDATE question_notifications SET next_attempt_at=now()-interval '1 second',lease_until=NULL WHERE block_id=$1",
      [id]
    );
    await new QuestionAlerts(pool, send, live).tick();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("refuses a thread from an earlier Slack connection before claiming, leaving the ordinary reminder", async () => {
    const id = await form();
    const send = vi.fn(async () => true);
    const outcome = await new QuestionAlerts(pool, send, live).sendNow(id, {
      threadTs: "1.0",
      generation: "old",
    });
    expect(outcome.delivery).toBe("not_sent");
    expect(send).not.toHaveBeenCalled();
    expect(await row(id)).toBeUndefined();
  });

  it("does nothing without a connected Slack app", async () => {
    const id = await form();
    const send = vi.fn(async () => true);
    const outcome = await new QuestionAlerts(
      pool,
      send,
      async () => null
    ).sendNow(id);
    expect(outcome.delivery).toBe("not_sent");
    expect(send).not.toHaveBeenCalled();
    expect(await row(id)).toBeUndefined();
  });
});
