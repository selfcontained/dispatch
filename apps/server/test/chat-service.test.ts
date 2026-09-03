import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { ChatService, ChatValidationError } from "../src/chat/service.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;
let service: ChatService;
let published: unknown[];

const A = "agt_chat_svc";
const PINS = [{ id: "pin_1", label: "URL", value: "http://x", type: "url" }];

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  await pool.query(
    `INSERT INTO agents (id, name, cwd, status) VALUES ($1, 'Svc', '/tmp', 'running')`,
    [A]
  );
  published = [];
  service = new ChatService({
    pool,
    publishUiEvent: (event) => published.push(event),
    getAgent: async (id) =>
      id === A ? { id, mediaDir: null, pins: PINS as never } : null,
    mediaRoot: "/tmp/media-root",
  });
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  published.length = 0;
  await pool.query("DELETE FROM agent_chat_messages");
  await pool.query("DELETE FROM media");
});

describe("ChatService.post", () => {
  it("persists an agent message and publishes chat.changed", async () => {
    const message = await service.post(A, { text: "hello", kind: "update" });
    expect(message).toMatchObject({
      agentId: A,
      authorKind: "agent",
      kind: "update",
      text: "hello",
    });
    expect(published).toEqual([{ type: "chat.changed", agentId: A }]);
  });

  it("drops a stray question on non-question kinds at the service boundary", async () => {
    await expect(
      service.post(A, { text: "x", question: { options: [{ label: "a" }] } })
    ).rejects.toBeInstanceOf(ChatValidationError);
    await expect(
      service.post(A, { text: "x", kind: "question" })
    ).rejects.toThrow(/question .* required/);
  });

  it("resolves file attachments to the media row by shared path or stored copy", async () => {
    await pool.query(
      `INSERT INTO media (agent_id, file_name, source, size_bytes)
       VALUES ($1, 'shot-2026-01-01-00-00-00-000.png', 'screenshot', 123),
              ($1, 'shot-2026-01-02-00-00-00-000.png', 'screenshot', 456)`,
      [A]
    );
    const message = await service.post(A, {
      text: "see",
      attachments: [
        { type: "file", path: "/tmp/shots/shot.png" },
        {
          type: "file",
          path: "/tmp/media-root/agt/shot-2026-01-01-00-00-00-000.png",
        },
        { type: "link", url: "https://example.com" },
        { type: "pin", pinId: "pin_1" },
      ],
    });
    expect(message.attachments).toHaveLength(4);
    // Newest copy wins for the original path.
    expect(message.attachments[0]).toMatchObject({
      type: "file",
      path: "/tmp/shots/shot.png",
      fileName: "shot-2026-01-02-00-00-00-000.png",
      sizeBytes: 456,
      mimeType: "image/png",
    });
    expect(
      (message.attachments[0] as { mediaId: number }).mediaId
    ).toBeGreaterThan(0);
    // The stored copy's own name resolves exactly.
    expect(message.attachments[1]).toMatchObject({
      fileName: "shot-2026-01-01-00-00-00-000.png",
      sizeBytes: 123,
    });
    expect(message.attachments[2]).toEqual({
      type: "link",
      url: "https://example.com",
    });
    expect(message.attachments[3]).toEqual({ type: "pin", pinId: "pin_1" });
  });

  it("rejects unknown files and unknown pins", async () => {
    await expect(
      service.post(A, {
        text: "see",
        attachments: [{ type: "file", path: "/tmp/never-shared.png" }],
      })
    ).rejects.toThrow(/Unknown file .* dispatch_share_file/);
    await expect(
      service.post(A, {
        text: "see",
        attachments: [{ type: "pin", pinId: "pin_missing" }],
      })
    ).rejects.toThrow(/Unknown pin/);
    expect(published).toEqual([]);
  });
});

describe("ChatService.update", () => {
  it("edits only the agent's own agent messages", async () => {
    const mine = await service.post(A, { text: "draft" });
    published.length = 0;
    const updated = await service.update(A, mine.id, {
      text: "final",
      kind: "summary",
    });
    expect(updated).toMatchObject({ text: "final", kind: "summary" });
    expect(published).toEqual([{ type: "chat.changed", agentId: A }]);

    await expect(
      service.update("agt_other", mine.id, { text: "hijack" })
    ).rejects.toThrow(/only edits your own/);

    const userRow = await service.store.insert({
      agentId: A,
      authorKind: "user",
      text: "from user",
    });
    await expect(
      service.update(A, userRow.id, { text: "nope" })
    ).rejects.toThrow(/only edits your own/);
  });

  it("requires a question when switching to kind=question and clears it when switching away", async () => {
    const m = await service.post(A, { text: "x" });
    await expect(service.update(A, m.id, { kind: "question" })).rejects.toThrow(
      /question .* required/
    );
    const asQuestion = await service.update(A, m.id, {
      kind: "question",
      question: { options: [{ label: "a" }] },
    });
    expect(asQuestion.question).toEqual({ options: [{ label: "a" }] });
    const back = await service.update(A, m.id, { kind: "reply" });
    expect(back.kind).toBe("reply");
    expect(back.question).toBeNull();
  });

  it("replaces attachments wholesale", async () => {
    const m = await service.post(A, {
      text: "x",
      attachments: [{ type: "link", url: "https://a.com" }],
    });
    const updated = await service.update(A, m.id, {
      attachments: [{ type: "code", code: "let x = 1", language: "ts" }],
    });
    expect(updated.attachments).toEqual([
      { type: "code", code: "let x = 1", language: "ts" },
    ]);
  });
});
