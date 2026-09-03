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

vi.mock("../src/shared/git/git-context.js", () => ({
  resolveRepoRoot: vi.fn(async () => "/repo"),
  resolveWorktreeRoot: vi.fn(async () => "/repo"),
}));

import { createMcpHandlers } from "../src/server/mcp-handlers.js";
import { MessageStore } from "../src/messages/store.js";
import { resolveRepoRoot } from "../src/shared/git/git-context.js";
import { setupTestDb, teardownTestDb, runTestMigrations } from "./db/setup.js";

let pool: Pool;
let handlers: ReturnType<typeof createMcpHandlers>;
let enqueueAgentPrompt: ReturnType<typeof vi.fn>;
let publishUiEvent: ReturnType<typeof vi.fn>;
let agentManager: {
  getAgent: ReturnType<typeof vi.fn>;
  listAgents: ReturnType<typeof vi.fn>;
};

const SENDER = {
  id: "agt_sender",
  name: "sender-agent",
  cwd: "/repo",
  status: "running",
};
const RECEIVER = {
  id: "agt_receiver",
  name: "receiver-agent",
  cwd: "/repo",
  status: "running",
};

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await pool.query("DELETE FROM agent_messages");
  vi.mocked(resolveRepoRoot).mockResolvedValue("/repo");

  enqueueAgentPrompt = vi.fn(async () => ({
    held: false,
    delivery: Promise.resolve(),
  }));
  publishUiEvent = vi.fn();
  agentManager = {
    getAgent: vi.fn(async (id: string) =>
      id === SENDER.id ? SENDER : id === RECEIVER.id ? RECEIVER : null
    ),
    listAgents: vi.fn(async () => [SENDER, RECEIVER]),
  };

  handlers = createMcpHandlers({
    pool,
    mediaRoot: "/tmp/media",
    agentManager: agentManager as any,
    jobService: {} as any,
    slackNotifier: {} as any,
    publishUiEvent,
    withStreamFlag: vi.fn((agent: any) => ({ ...agent, hasStream: false })),
    sendAgentPrompt: vi.fn(async () => {}),
    enqueueAgentPrompt,
    appLog: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    } as any,
  } as unknown as Parameters<typeof createMcpHandlers>[0]);
});

async function rowFor(content: string) {
  const rows = await pool.query<{ delivered: boolean | null }>(
    "SELECT sender_agent_id, recipient_agent_id, content, delivered FROM agent_messages WHERE content = $1",
    [content]
  );
  expect(rows.rows).toHaveLength(1);
  return rows.rows[0] as {
    sender_agent_id: string;
    recipient_agent_id: string;
    delivered: boolean | null;
  };
}

async function settled(content: string): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    const row = await rowFor(content);
    if (row.delivered !== null) return row.delivered;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("delivery never settled");
}

const CREATED = {
  type: "message.created",
  senderAgentId: SENDER.id,
  recipientAgentId: RECEIVER.id,
};

describe("sendMessage persistence", () => {
  it("persists a pending row on enqueue, then settles delivered=true and republishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    enqueueAgentPrompt.mockResolvedValueOnce({ held: true, delivery: gate });

    const result = await handlers.sendMessage(SENDER.id, {
      target: RECEIVER.id,
      message: "ping",
      senderRepoRoot: "/repo",
    });
    expect(result.delivered).toBe(true);

    // Queued but not written: the row is pending and one event announced it.
    const pending = await rowFor("ping");
    expect(pending.sender_agent_id).toBe(SENDER.id);
    expect(pending.recipient_agent_id).toBe(RECEIVER.id);
    expect(pending.delivered).toBeNull();
    expect(publishUiEvent).toHaveBeenCalledTimes(1);
    expect(publishUiEvent).toHaveBeenCalledWith(
      expect.objectContaining(CREATED)
    );

    release();
    expect(await settled("ping")).toBe(true);
    expect(publishUiEvent).toHaveBeenCalledTimes(2);
    expect(publishUiEvent).toHaveBeenLastCalledWith(
      expect.objectContaining(CREATED)
    );
  });

  it("settles delivered=false when the pane write fails after enqueue", async () => {
    // Reject from inside the enqueue, as the real injector would: the
    // handler must attach its outcome handler before anything else awaits.
    enqueueAgentPrompt.mockImplementationOnce(async () => ({
      held: false,
      delivery: Promise.reject(new Error("pane gone")),
    }));
    await handlers.sendMessage(SENDER.id, {
      target: RECEIVER.id,
      message: "late fail",
      senderRepoRoot: "/repo",
    });
    expect(await settled("late fail")).toBe(false);
    expect(publishUiEvent).toHaveBeenCalledTimes(2);
  });

  it("records a failed enqueue as delivered=false and still throws", async () => {
    enqueueAgentPrompt.mockRejectedValueOnce(new Error("tmux boom"));

    await expect(
      handlers.sendMessage(SENDER.id, {
        target: RECEIVER.id,
        message: "will fail",
        senderRepoRoot: "/repo",
      })
    ).rejects.toThrow("tmux boom");

    expect((await rowFor("will fail")).delivered).toBe(false);
    expect(publishUiEvent).toHaveBeenCalledTimes(1);
    expect(publishUiEvent).toHaveBeenCalledWith(
      expect.objectContaining(CREATED)
    );
  });

  it("sweeps rows left pending by a previous process to delivered=false", async () => {
    const store = new MessageStore(pool);
    for (const content of ["stale-1", "stale-2"]) {
      await store.insertMessage({
        senderAgentId: SENDER.id,
        recipientAgentId: RECEIVER.id,
        senderName: SENDER.name,
        recipientName: RECEIVER.name,
        content,
        delivered: null,
        senderRepoRoot: "/repo",
        recipientRepoRoot: "/repo",
      });
    }
    await store.insertMessage({
      senderAgentId: RECEIVER.id,
      recipientAgentId: SENDER.id,
      senderName: RECEIVER.name,
      recipientName: SENDER.name,
      content: "done",
      delivered: true,
      senderRepoRoot: "/repo",
      recipientRepoRoot: "/repo",
    });

    const pairs = await store.sweepPendingDeliveries();
    expect(pairs).toEqual([
      { senderAgentId: SENDER.id, recipientAgentId: RECEIVER.id },
    ]);
    expect((await rowFor("stale-1")).delivered).toBe(false);
    expect((await rowFor("stale-2")).delivered).toBe(false);
    expect((await rowFor("done")).delivered).toBe(true);
    expect(await store.sweepPendingDeliveries()).toEqual([]);
  });
});
