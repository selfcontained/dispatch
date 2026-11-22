/**
 * Scheduled occurrences for an agent on a held runner, through the real
 * scheduled-message service and the real runtime queue: the occurrence keeps
 * its persisted pending id while held, recurring ticks coalesce onto it,
 * expiry still applies, and it is delivered once after release, including
 * after a controller restart mid-hold.
 */
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { createAcpRuntime } from "../src/agents/acp/runtime.js";
import type { AgentManager } from "../src/agents/manager.js";
import {
  RunnerUpdateHolds,
  type RunnerHoldState,
} from "../src/agents/remote/update-hold.js";
import type { StreamService } from "../src/chat/service.js";
import { ScheduledMessageService } from "../src/scheduled-messages/service.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";
import { scriptedHost } from "./runner-update-hold-fixtures.js";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => logger,
  level: "silent",
} as unknown as Parameters<typeof createAcpRuntime>[0]["logger"];

const ATTEMPT = "11111111-1111-4111-8111-111111111111";
const id = "agt_held";

let pool: Pool;
let cleanup: Array<() => void> = [];
let saved: RunnerHoldState = { holds: [], resuming: [] };

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  await pool.query(
    "INSERT INTO agents(id,name,cwd,status) VALUES ($1,'Held','runner://r1/proof','running')",
    [id]
  );
});
afterAll(teardownTestDb);
beforeEach(async () => {
  await pool.query("DELETE FROM scheduled_messages");
  saved = { holds: [], resuming: [] };
});
afterEach(() => {
  for (const run of cleanup.splice(0).reverse()) run();
});

/** One controller process: holds read from the shared record, a runtime, a scheduler. */
async function controller(socket: string, stateRoot: string) {
  const holds = new RunnerUpdateHolds({
    store: {
      read: async () => saved,
      write: async (next) => {
        saved = next;
      },
    },
    logger,
  });
  await holds.load();
  holds.start();
  cleanup.push(() => holds.close());
  const runtime = createAcpRuntime({
    config: {
      agentStateRoot: stateRoot,
      agentRuntime: "acp",
      dispatchBinDir: "/nonexistent",
    },
    logger,
    hostSeq: async () => ({ seq: 0, journalId: null }),
    syncJournal: async () => {},
    placement: async () => ({ runner: "r1", workspace: "proof" }),
    remote: {
      available: () => true,
      requestSession: async () => ({
        value: true,
        channel: net.createConnection(socket),
      }),
    } as never,
    holds,
  });
  expect(await runtime.attach(id)).toBe(true);
  const deliveries: ReturnType<typeof runtime.prompt>[] = [];
  const service = new ScheduledMessageService(
    pool,
    {
      getAgent: async () => ({ id, status: "running" }),
      getTerminalAccess: async () => ({ mode: "live" }),
      promptAgent: (
        agentId: string,
        text: string,
        source: never,
        opts: never
      ) => {
        const delivery = runtime.prompt(agentId, text, source, opts);
        deliveries.push(delivery);
        return delivery;
      },
    } as unknown as AgentManager,
    {
      scheduledNoticeOutcome: async () => {},
      scheduledNoticePending: async () => {},
      scheduledNotice: async () => ({ id: crypto.randomUUID() }),
      refreshScheduledNotice: async () => {},
      resolvePromptSource: async (_id: string, s: unknown) => s,
    } as unknown as StreamService,
    { warn: () => {} }
  );
  cleanup.push(() => service.stop());
  /** Every submitted occurrence settled, and the service recorded it. */
  async function delivered() {
    await Promise.all(deliveries.map(({ settled }) => settled));
    // The service queues its bookkeeping in the agent's order as each settles.
    await service["serial"](id, async () => {});
  }
  return { holds, runtime, service, delivered };
}

async function host() {
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "dispatch-hold-sched-"));
  cleanup.push(() => rmSync(stateRoot, { recursive: true, force: true }));
  const fixture = await scriptedHost(cleanup, stateRoot, id);
  return { ...fixture, stateRoot };
}

const recurring = () => ({
  title: "Check deployment",
  message: "Check it",
  deliver_at: new Date(Date.now() + 1000).toISOString(),
  interval_seconds: 300,
  stop_when: "Deployment complete",
  max_deliveries: 20,
});

describe("scheduled occurrences on a held runner", () => {
  it("keeps one pending occurrence across recurring ticks and delivers it once on release", async () => {
    const { prompts, socket, stateRoot } = await host();
    const { holds, service, delivered } = await controller(socket, stateRoot);
    await holds.begin("r1", ATTEMPT);
    const s = await service.create(id, recurring());
    const due = Date.parse(s.deliverAt);

    await service.tick(due);
    const first = (await service.list(id))[0]!.outstanding!;
    expect(first.phase).toBe("pending");
    expect(holds.counts("r1")).toMatchObject({ scheduled: 1 });

    await service.tick(due + 15 * 60 * 1000);
    expect(holds.counts("r1")).toMatchObject({ scheduled: 1 });
    const later = (await service.list(id))[0]!.outstanding!;
    expect(later).toMatchObject({ id: first.id, phase: "pending", ticks: 4 });
    expect(prompts).toEqual([]);

    await holds.release("r1", ATTEMPT, "committed");
    await delivered();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.text).toContain("Schedule ID: " + s.id);
    const after = (await service.list(id))[0]!;
    expect(after.deliveredCount).toBe(1);
  });

  it("expires a held occurrence and never sends it", async () => {
    const { prompts, socket, stateRoot } = await host();
    const { holds, service, delivered } = await controller(socket, stateRoot);
    await holds.begin("r1", ATTEMPT);
    const s = await service.create(id, recurring());
    await service.tick(Date.parse(s.deliverAt));
    expect(holds.counts("r1")).toMatchObject({ scheduled: 1 });
    await pool.query(
      "UPDATE scheduled_messages SET payload=jsonb_set(payload,'{expiresAt}',to_jsonb($2::text)) WHERE id=$1",
      [s.id, new Date(Date.now() - 1).toISOString()]
    );
    await service.tick();
    await delivered();
    expect((await service.list(id))[0]!).toMatchObject({
      status: "expired",
      outstanding: null,
    });
    expect(holds.counts("r1")).toMatchObject({ scheduled: 0 });

    await holds.release("r1", ATTEMPT, "committed");
    await delivered();
    expect(prompts).toEqual([]);
  });

  it("delivers a held occurrence once after a controller restart mid-hold", async () => {
    const { prompts, socket, stateRoot } = await host();
    const before = await controller(socket, stateRoot);
    await before.holds.begin("r1", ATTEMPT);
    const s = await before.service.create(id, recurring());
    await before.service.tick(Date.parse(s.deliverAt));
    expect(before.holds.counts("r1")).toMatchObject({ scheduled: 1 });
    const pending = (await before.service.list(id))[0]!.outstanding!;
    // The old process dies holding it in memory; its hold is never released.
    before.service.stop();
    before.holds.close();

    const after = await controller(socket, stateRoot);
    expect(after.holds.isHeld("r1")).toBe(true);
    await after.service.start();
    after.service.stop();
    await after.service.tick();
    expect(after.holds.counts("r1")).toMatchObject({ scheduled: 1 });
    expect((await after.service.list(id))[0]!.outstanding).toMatchObject({
      id: pending.id,
      phase: "pending",
    });
    expect(prompts).toEqual([]);

    await after.holds.release("r1", ATTEMPT, "rolled_back");
    await after.delivered();
    expect(prompts).toHaveLength(1);
    expect((await after.service.list(id))[0]!.deliveredCount).toBe(1);
  });
});
