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
import { resolveRepoRoot } from "../src/shared/git/git-context.js";
import { setupTestDb, teardownTestDb, runTestMigrations } from "./db/setup.js";

let pool: Pool;
let handlers: ReturnType<typeof createMcpHandlers>;
let sendAgentPrompt: ReturnType<typeof vi.fn>;
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

beforeEach(() => {
  vi.mocked(resolveRepoRoot).mockResolvedValue("/repo");

  sendAgentPrompt = vi.fn(async () => {});
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
    sendAgentPrompt,
    appLog: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    } as any,
  } as unknown as Parameters<typeof createMcpHandlers>[0]);
});

describe("sendMessage persistence", () => {
  it("persists a row and emits message.created on send", async () => {
    await handlers.sendMessage(SENDER.id, {
      target: RECEIVER.id,
      message: "ping",
      senderRepoRoot: "/repo",
    });

    const rows = await pool.query(
      "SELECT sender_agent_id, recipient_agent_id, content, delivered FROM agent_messages WHERE content = $1",
      ["ping"]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].sender_agent_id).toBe(SENDER.id);
    expect(rows.rows[0].recipient_agent_id).toBe(RECEIVER.id);
    expect(rows.rows[0].delivered).toBe(true);

    expect(publishUiEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "message.created",
        senderAgentId: SENDER.id,
        recipientAgentId: RECEIVER.id,
      })
    );
  });

  it("records a failed delivery as delivered=false and still throws", async () => {
    sendAgentPrompt.mockRejectedValueOnce(new Error("tmux boom"));

    await expect(
      handlers.sendMessage(SENDER.id, {
        target: RECEIVER.id,
        message: "will fail",
        senderRepoRoot: "/repo",
      })
    ).rejects.toThrow("tmux boom");

    const rows = await pool.query(
      "SELECT delivered FROM agent_messages WHERE content = $1",
      ["will fail"]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].delivered).toBe(false);

    expect(publishUiEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "message.created",
        senderAgentId: SENDER.id,
        recipientAgentId: RECEIVER.id,
      })
    );
  });
});
