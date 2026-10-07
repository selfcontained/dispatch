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
import { scheduledMessageCadence } from "@dispatch/shared";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";
import { ScheduledMessageService } from "../src/scheduled-messages/service.js";
import {
  nextBoundary,
  validateSchedule,
} from "../src/scheduled-messages/validation.js";
import type { AgentManager } from "../src/agents/manager.js";
import type { StreamService } from "../src/chat/service.js";
import type {
  PromptOptions,
  PromptSource,
} from "../src/agents/acp/prompt-source.js";

let pool: Pool;
const id = "agt_scheduled_test";
let service: ScheduledMessageService;
let source: PromptSource;
let options: PromptOptions;
let accept: () => void;
let settle: () => void;
let reject: (error: Error) => void;
let prompt: ReturnType<typeof vi.fn>;
let live = true;
let notice: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.fn>;
let outcome: ReturnType<typeof vi.fn>;
const input = () => ({
  title: "Check deployment",
  message: "Check it",
  deliver_at: new Date(Date.now() + 1000).toISOString(),
  interval_seconds: 300,
  stop_when: "Deployment complete",
  max_deliveries: 20,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  await pool.query(
    "INSERT INTO agents(id,name,cwd,status) VALUES ($1,'Scheduler','/tmp','running')",
    [id]
  );
});
afterAll(teardownTestDb);
beforeEach(async () => {
  await pool.query("DELETE FROM scheduled_messages");
  live = true;
  prompt = vi.fn((_id, _text, s, opts) => {
    source = s;
    options = opts;
    return {
      accepted: new Promise<void>((res, rej) => {
        accept = res;
        reject = rej;
      }),
      settled: new Promise<void>((res) => {
        settle = res;
      }),
    };
  });
  notice = vi.fn(async () => ({ id: crypto.randomUUID() }));
  warn = vi.fn();
  outcome = vi.fn(async () => {});
  service = new ScheduledMessageService(
    pool,
    {
      getAgent: async () => ({ id, status: "running" }),
      getTerminalAccess: async () => ({ mode: live ? "live" : "inert" }),
      promptAgent: prompt,
    } as unknown as AgentManager,
    {
      scheduledNoticeOutcome: outcome,
      scheduledNoticePending: async () => {},
      scheduledNotice: notice,
      refreshScheduledNotice: async () => {},
      resolvePromptSource: async (_id: string, s: PromptSource) => s,
    } as unknown as StreamService,
    { warn }
  );
});
describe("scheduled messages", () => {
  it.each([
    [90, "Every 1 minute 30 seconds"],
    [100, "Every 1 minute 40 seconds"],
    [7200, "Every 2 hours"],
  ] as const)("formats %s seconds in whole units", (seconds, text) => {
    expect(scheduledMessageCadence(seconds)).toBe(text);
  });
  it("settles unconfirmed delivery presentation when restart suspends submitting work", async () => {
    const s = await service.create(id, input());
    await service.tick(Date.parse(s.deliverAt));
    await options.beforeSubmit!();
    const blockId = (await service.list(id))[0]!.outstanding!.blockId;
    await service.start();
    service.stop();
    expect(outcome).toHaveBeenCalledWith(blockId, id, false, "uncertain");
    expect((await service.list(id))[0]!.status).toBe("uncertain");
    settle();
  });
  it.each(["completed", "expired", "limit_reached", "cancelled"])(
    "does not rewrite terminal %s history on cancellation",
    async (status) => {
      const s = await service.create(id, input());
      await pool.query(
        "UPDATE scheduled_messages SET payload=jsonb_set(payload,'{status}',to_jsonb($2::text)) WHERE id=$1",
        [s.id, status]
      );
      for (const completed of [false, true]) {
        const result = await service.change(id, s.id, "cancel", completed);
        expect(result.status).toBe(status);
        expect((await service.list(id))[0]!.status).toBe(status);
      }
    }
  );
  it("returns the committed schedule when notice creation fails and recovers its card later", async () => {
    notice.mockRejectedValueOnce(new Error("stream unavailable"));
    const s = await service.create(id, input());
    expect(s.status).toBe("active");
    expect(s.cardId).toBeNull();
    expect(await service.list(id)).toHaveLength(1);
    expect(warn).toHaveBeenCalledOnce();
    const paused = await service.change(id, s.id, "pause");
    expect(paused.cardId).not.toBeNull();
    expect((await service.list(id))[0]!.cardId).toBe(paused.cardId);
  });
  it("returns success when saving the card fails after schedule commit", async () => {
    const spy = vi
      .spyOn(pool, "query")
      .mockImplementationOnce(
        () => Promise.reject(new Error("card save unavailable")) as never
      );
    try {
      const s = await service.create(id, input());
      expect(s.status).toBe("active");
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
    expect(await service.list(id)).toHaveLength(1);
  });
  it("collapses four ticks until pickup, counts acceptance, then keeps original cadence", async () => {
    const s = await service.create(id, input());
    const due = Date.parse(s.deliverAt);
    await service.tick(due);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(await options.beforeSubmit!()).toBe(true);
    accept();
    await flush();
    await service.tick(due + 15 * 60 * 1000);
    let current = (await service.list(id))[0]!;
    expect(current.outstanding?.ticks).toBe(4);
    expect(current.deliveredCount).toBe(1);
    expect(prompt).toHaveBeenCalledTimes(1);
    await service.receipt({
      type: "steering_picked_up",
      agentId: id,
      receiptId: "receipt",
      source,
      at: new Date().toISOString(),
    });
    current = (await service.list(id))[0]!;
    expect(current.outstanding).toBeNull();
    settle();
    await flush();
  });
  it("cancels unaccepted queued delivery but leaves accepted delivery in place", async () => {
    const s = await service.create(id, input());
    await service.tick(Date.parse(s.deliverAt));
    await service.change(id, s.id, "cancel");
    expect(options.signal?.aborted).toBe(true);
    expect(await options.beforeSubmit!()).toBe(false);
    reject(new Error("cancelled"));
    settle();
    await flush();
    const other = await service.create(id, input());
    await service.tick(Date.parse(other.deliverAt));
    await options.beforeSubmit!();
    accept();
    await flush();
    await service.change(id, other.id, "cancel");
    const cancelled = (await service.list(id)).find((s) => s.id === other.id)!;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.outstanding?.phase).toBe("accepted");
    expect(cancelled.deliveredCount).toBe(1);
    settle();
    await flush();
  });
  it("enforces expiry at submission, even if the message became due earlier", async () => {
    const s = await service.create(id, input());
    await service.tick(Date.parse(s.deliverAt));
    await pool.query(
      "UPDATE scheduled_messages SET payload=jsonb_set(payload,'{expiresAt}',to_jsonb($2::text)) WHERE id=$1",
      [s.id, new Date(Date.now() - 1).toISOString()]
    );
    expect(await options.beforeSubmit!()).toBe(false);
    await service.tick();
    expect((await service.list(id))[0]!.status).toBe("expired");
    reject(new Error("expired"));
    settle();
    await flush();
  });
  it("suspends ambiguous acceptance even when paused during submission", async () => {
    const s = await service.create(id, input());
    await service.tick(Date.parse(s.deliverAt));
    await options.beforeSubmit!();
    await service.change(id, s.id, "pause");
    reject(new Error("connection lost after submission"));
    settle();
    await flush();
    expect((await service.list(id))[0]!.status).toBe("uncertain");
  });

  it("does not resume after its final delivery was accepted while paused", async () => {
    const s = await service.create(id, { ...input(), max_deliveries: 1 });
    await service.tick(Date.parse(s.deliverAt));
    await options.beforeSubmit!();
    await service.change(id, s.id, "pause");
    accept();
    await flush();
    const resumed = await service.change(id, s.id, "resume");
    expect(resumed.status).toBe("limit_reached");
    settle();
    await flush();
  });

  it("returns declined steering to pending for safe queued recovery", async () => {
    const s = await service.create(id, input());
    await service.tick(Date.parse(s.deliverAt));
    await options.beforeSubmit!();
    await options.onDeferred!();
    expect((await service.list(id))[0]!.outstanding?.phase).toBe("pending");
    await service.change(id, s.id, "cancel");
    reject(new Error("cancelled"));
    settle();
    await flush();
  });

  it("resumes on a future boundary without paused catch-up", async () => {
    const s = await service.create(id, input());
    await service.change(id, s.id, "pause");
    const resumed = await service.change(id, s.id, "resume");
    expect(resumed.status).toBe("active");
    expect(Date.parse(resumed.nextDueAt)).toBeGreaterThan(Date.now());
  });
  it("retains one pending occurrence while offline and recovers it after restart", async () => {
    live = false;
    const s = await service.create(id, input());
    await service.tick(Date.parse(s.deliverAt) + 15 * 60 * 1000);
    expect(prompt).not.toHaveBeenCalled();
    expect((await service.list(id))[0]!.outstanding?.ticks).toBe(4);
    await service.start();
    service.stop();
    live = true;
    await service.tick();
    expect(prompt).toHaveBeenCalledTimes(1);
    await options.beforeSubmit!();
    accept();
    settle();
    await flush();
  });
  it("suspends ambiguous accepted delivery after restart rather than resending", async () => {
    const s = await service.create(id, input());
    await service.tick(Date.parse(s.deliverAt));
    await options.beforeSubmit!();
    accept();
    await flush();
    await service.start();
    service.stop();
    expect((await service.list(id))[0]!.status).toBe("uncertain");
    expect(prompt).toHaveBeenCalledTimes(1);
    settle();
    await flush();
  });
  it("ends one-shots automatically and enforces the ten-schedule cap", async () => {
    const s = await service.create(id, {
      title: "Once",
      message: "Check",
      deliver_at: input().deliver_at,
    });
    await service.tick(Date.parse(s.deliverAt));
    await options.beforeSubmit!();
    accept();
    settle();
    await flush();
    expect((await service.list(id))[0]!.status).toBe("completed");
    for (let n = 0; n < 10; n++) await service.create(id, input());
    await expect(service.create(id, input())).rejects.toThrow("ten");
  });
  it("requires bounded recurrence and validates lifetime and timezone", () => {
    const now = Date.now();
    expect(() =>
      validateSchedule({ ...input(), max_deliveries: undefined }, now)
    ).toThrow("Recurring");
    expect(() =>
      validateSchedule(
        { ...input(), expires_at: new Date(now + 8 * 86400000).toISOString() },
        now
      )
    ).toThrow("seven days");
    expect(
      nextBoundary(
        "2026-01-01T00:00:00Z",
        300,
        Date.parse("2026-01-01T00:22:00Z")
      )
    ).toBe("2026-01-01T00:25:00.000Z");
  });
});
