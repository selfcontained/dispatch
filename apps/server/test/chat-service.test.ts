import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import {
  ChatConflictError,
  ChatNotFoundError,
  ChatService,
  ChatValidationError,
  LAUNCH_POST_TRUNCATED_NOTE,
  type ChatDeliveryAdapter,
  validateChatContent,
} from "../src/chat/service.js";
import type { ChatMessage } from "@dispatch/shared";
import { CHAT_ATTACHMENTS_MAX, CHAT_MESSAGE_MAX_CHARS } from "@dispatch/shared";
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
    `INSERT INTO agents (id, name, cwd, status)
     VALUES ($1, 'Svc', '/tmp', 'running'),
            ('agt_someone_else', 'Else', '/tmp', 'running')`,
    [A]
  );
  published = [];
  service = new ChatService({
    pool,
    publishUiEvent: (event) => published.push(event),
    getAgent: async (id) =>
      id === A ? { id, mediaDir: null, pins: PINS as never } : null,
    mediaRoot: "/media-root",
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

describe("ChatService.recordLaunchContext", () => {
  async function seedMedia(fileName: string, size = 12): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO media (agent_id, file_name, source, size_bytes)
       VALUES ($1, $2, 'user', $3) RETURNING id`,
      [A, fileName, size]
    );
    return result.rows[0].id;
  }

  it("records one delivered user post with file, link and pin attachments", async () => {
    const mediaId = await seedMedia("brief-2026.md", 300);
    const message = await service.recordLaunchContext({
      agentId: A,
      text: "Build the widget",
      files: [{ mediaId }],
      links: ["https://example.com/spec"],
      pins: [{ id: "pin_1", type: "url", value: "http://x" }],
    });
    expect(message).toMatchObject({
      agentId: A,
      authorKind: "user",
      kind: "reply",
      text: "Build the widget",
      delivered: true,
      origin: "launch",
      attachments: [
        {
          type: "file",
          mediaId,
          fileName: "brief-2026.md",
          sizeBytes: 300,
          mimeType: "text/markdown",
        },
        { type: "link", url: "https://example.com/spec" },
        { type: "pin", pinId: "pin_1" },
      ],
    });
    expect(message && "launchedByAgentId" in message).toBe(false);
    expect(published).toEqual([{ type: "chat.changed", agentId: A }]);
    expect(await service.store.getById(message!.id)).toEqual(message);
  });

  it("skips a url pin that duplicates a startup link", async () => {
    const message = await service.recordLaunchContext({
      agentId: A,
      text: "",
      links: ["http://x"],
      pins: [{ id: "pin_1", type: "url", value: "http://x" }],
    });
    expect(message?.attachments).toEqual([{ type: "link", url: "http://x" }]);
    expect(message?.text).toBe("");
  });

  it("records nothing for a launch with no context", async () => {
    expect(
      await service.recordLaunchContext({ agentId: A, text: "   " })
    ).toBeNull();
    expect(published).toEqual([]);
    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM agent_chat_messages WHERE agent_id = $1`,
      [A]
    );
    expect(rows.rows[0].n).toBe(0);
  });

  it("attributes the post to the launching agent", async () => {
    const message = await service.recordLaunchContext({
      agentId: A,
      text: "Review the diff",
      launchedByAgentId: "agt_someone_else",
    });
    expect(message).toMatchObject({
      authorKind: "user",
      origin: "launch",
      launchedByAgentId: "agt_someone_else",
      delivered: true,
    });
  });

  it("rejects an unknown file or pin like any user attachment", async () => {
    await expect(
      service.recordLaunchContext({
        agentId: A,
        text: "x",
        files: [{ mediaId: 999_999 }],
      })
    ).rejects.toBeInstanceOf(ChatValidationError);
    await expect(
      service.recordLaunchContext({
        agentId: A,
        text: "x",
        pins: [{ id: "pin_nope", type: "string", value: "v" }],
      })
    ).rejects.toBeInstanceOf(ChatValidationError);
  });
});

describe("ChatService.prepareLaunchContext", () => {
  it("resolves the post's id and envelope lines before anything is written", async () => {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO media (agent_id, file_name, source, size_bytes)
       VALUES ($1, 'brief-2026.md', 'user', 300) RETURNING id`,
      [A]
    );
    const mediaId = result.rows[0].id;
    const prepared = await service.prepareLaunchContext({
      id: "8a4f9e60-1111-4222-8333-444455556666",
      agentId: A,
      text: "Build the widget",
      files: [{ mediaId }],
      links: ["https://example.com/spec"],
      pins: [{ id: "pin_1", type: "string", value: "DIS-42" }],
    });
    expect(prepared?.id).toBe("8a4f9e60-1111-4222-8333-444455556666");
    // The same lines sendUserMessage injects, so pane and post agree.
    expect(prepared?.attachmentLines).toEqual([
      "- file: /media-root/agt_chat_svc/brief-2026.md (text/markdown, 300 B)",
      "- link: https://example.com/spec",
      "- pin: URL — http://x",
    ]);
    // Nothing written and nothing announced until record() runs.
    expect(published).toEqual([]);
    const rows = await pool.query(
      "SELECT id FROM agent_chat_messages WHERE agent_id = $1",
      [A]
    );
    expect(rows.rows).toHaveLength(0);

    const message = await prepared!.record();
    expect(message.id).toBe("8a4f9e60-1111-4222-8333-444455556666");
    expect(message).toMatchObject({ origin: "launch", delivered: true });
    expect(published).toEqual([{ type: "chat.changed", agentId: A }]);
  });

  it("returns null for a launch with no context", async () => {
    expect(
      await service.prepareLaunchContext({ agentId: A, text: "  " })
    ).toBeNull();
  });

  it("says so in the post when the prompt is longer than a Chat message", async () => {
    // dispatch_launch_agent accepts 100 000 chars; a Chat row holds 20 000.
    // The CLI still gets the whole prompt, so the row has to admit it is
    // showing less rather than quietly disagreeing with it.
    const prompt = "x".repeat(CHAT_MESSAGE_MAX_CHARS + 5_000);
    const prepared = await service.prepareLaunchContext({
      agentId: A,
      text: prompt,
    });
    expect(prepared?.postText.length).toBeLessThanOrEqual(
      CHAT_MESSAGE_MAX_CHARS
    );
    expect(prepared?.postText).toContain(LAUNCH_POST_TRUNCATED_NOTE);
    const message = await prepared!.record();
    expect(message.text).toBe(prepared?.postText);
    expect(message.text.length).toBeLessThanOrEqual(CHAT_MESSAGE_MAX_CHARS);
    expect(message.text.startsWith("x".repeat(1_000))).toBe(true);
  });

  it("leaves a prompt that fits exactly as written", async () => {
    const prompt = "y".repeat(CHAT_MESSAGE_MAX_CHARS);
    const prepared = await service.prepareLaunchContext({
      agentId: A,
      text: prompt,
    });
    expect(prepared?.postText).toBe(prompt);
  });

  it("describes every attachment for the turn while capping the row", async () => {
    const links = Array.from(
      { length: CHAT_ATTACHMENTS_MAX + 6 },
      (_, i) => `https://example.com/${i}`
    );
    const prepared = await service.prepareLaunchContext({
      agentId: A,
      text: "Build it",
      links,
    });
    expect(prepared?.attachmentLines).toHaveLength(links.length);
    expect(prepared?.attachmentLines?.at(-1)).toBe(
      `- link: ${links[links.length - 1]}`
    );
    expect(prepared?.postText).toContain("6 more startup attachments");
    const message = await prepared!.record();
    expect(message.attachments).toHaveLength(CHAT_ATTACHMENTS_MAX);
  });

  it("refuses to write a post whose id is already taken", async () => {
    const id = "7c1f0a10-2222-4333-8444-555566667777";
    const first = await service.prepareLaunchContext({
      agentId: A,
      id,
      text: "First",
    });
    await first!.record();
    const second = await service.prepareLaunchContext({
      agentId: A,
      id,
      text: "Second",
    });
    await expect(second!.record()).rejects.toBeInstanceOf(ChatConflictError);
    const rows = await pool.query<{ text: string }>(
      "SELECT text FROM agent_chat_messages WHERE id = $1",
      [id]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].text).toBe("First");
  });
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

  it("validates content once, at the service boundary", () => {
    expect(() => validateChatContent({ text: "  " })).toThrow(/not be empty/);
    expect(() => validateChatContent({ text: "x".repeat(20_001) })).toThrow(
      /20000 characters or fewer/
    );
    expect(() => validateChatContent({ text: "?", kind: "question" })).toThrow(
      /question .* required/
    );
    expect(() =>
      validateChatContent({
        text: "fyi",
        kind: "update",
        question: { options: [{ label: "a" }] },
      })
    ).toThrow(/only accepted when kind is "question"/);
    expect(() =>
      validateChatContent({
        text: "?",
        kind: "question",
        question: {
          options: Array.from({ length: 11 }, (_, i) => ({ label: `o${i}` })),
        },
      })
    ).toThrow(/10 entries or fewer/);
    expect(() =>
      validateChatContent({
        text: "x",
        attachments: Array.from({ length: 21 }, () => ({
          type: "link" as const,
          url: "https://example.com",
        })),
      })
    ).toThrow(/20 entries or fewer/);
  });

  it("drops a stray question on non-question kinds at the service boundary", async () => {
    await expect(
      service.post(A, { text: "x", question: { options: [{ label: "a" }] } })
    ).rejects.toBeInstanceOf(ChatValidationError);
    await expect(
      service.post(A, { text: "x", kind: "question" })
    ).rejects.toThrow(/question .* required/);
  });

  it("resolves file attachments by stored fileName or mediaId, never by path", async () => {
    await pool.query(
      `INSERT INTO media (agent_id, file_name, source, size_bytes)
       VALUES ($1, 'shot-2026-01-01-00-00-00-000.png', 'screenshot', 123),
              ($1, 'report.pdf', 'screenshot', 456),
              ('agt_someone_else', 'theirs.png', 'screenshot', 1)`,
      [A]
    );
    const pdf = await pool.query<{ id: number }>(
      `SELECT id FROM media WHERE file_name = 'report.pdf'`
    );
    const message = await service.post(A, {
      text: "see",
      attachments: [
        { type: "file", fileName: "shot-2026-01-01-00-00-00-000.png" },
        { type: "file", mediaId: pdf.rows[0].id },
        { type: "link", url: "https://example.com" },
        { type: "pin", pinId: "pin_1" },
      ],
    });
    expect(message.attachments).toHaveLength(4);
    expect(message.attachments[0]).toMatchObject({
      type: "file",
      fileName: "shot-2026-01-01-00-00-00-000.png",
      sizeBytes: 123,
      mimeType: "image/png",
    });
    expect(message.attachments[0]).not.toHaveProperty("path");
    expect(message.attachments[1]).toMatchObject({
      type: "file",
      mediaId: pdf.rows[0].id,
      fileName: "report.pdf",
      sizeBytes: 456,
      mimeType: "application/pdf",
    });
    expect(message.attachments[2]).toEqual({
      type: "link",
      url: "https://example.com",
    });
    expect(message.attachments[3]).toEqual({ type: "pin", pinId: "pin_1" });

    // A basename that merely resembles a share, another agent's file, or a
    // local path are all unknown.
    for (const fileName of ["shot.png", "theirs.png", "/tmp/report.pdf"]) {
      await expect(
        service.post(A, {
          text: "see",
          attachments: [{ type: "file", fileName }],
        })
      ).rejects.toThrow(/Unknown file/);
    }
    await expect(
      service.post(A, { text: "see", attachments: [{ type: "file" }] })
    ).rejects.toThrow(/fileName .* or mediaId/);
    // Two identifiers naming different rows: refused, never a guess.
    await expect(
      service.post(A, {
        text: "see",
        attachments: [
          {
            type: "file",
            fileName: "shot-2026-01-01-00-00-00-000.png",
            mediaId: pdf.rows[0].id,
          },
        ],
      })
    ).rejects.toThrow(/not both/);
    // Even when they agree.
    await expect(
      service.post(A, {
        text: "see",
        attachments: [
          { type: "file", fileName: "report.pdf", mediaId: pdf.rows[0].id },
        ],
      })
    ).rejects.toThrow(/not both/);
  });

  it("rejects unknown files and unknown pins", async () => {
    await expect(
      service.post(A, {
        text: "see",
        attachments: [{ type: "file", fileName: "never-shared.png" }],
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

  it("rejects a replyTo that names no message", async () => {
    // A well-formed UUID is not a claim on a thread; only a message on this
    // agent's own feed is.
    await expect(
      service.post(A, {
        text: "x",
        replyTo: "00000000-0000-4000-8000-000000000000",
      })
    ).rejects.toBeInstanceOf(ChatValidationError);
  });

  it("rejects a replyTo that belongs to another agent's feed", async () => {
    // The launcher of an agent knows real message ids from other feeds; a
    // forged envelope could hand one to the child.
    const theirs = await service.store.insert({
      agentId: "agt_someone_else",
      authorKind: "user",
      kind: "reply",
      text: "not yours",
    });
    await expect(
      service.post(A, { text: "x", replyTo: theirs.id })
    ).rejects.toThrow(/this agent's own Chat feed/);
    const rows = await pool.query(
      "SELECT id FROM agent_chat_messages WHERE agent_id = $1",
      [A]
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("accepts a replyTo that is a message on this agent's feed", async () => {
    const mine = await service.store.insert({
      agentId: A,
      authorKind: "user",
      kind: "reply",
      text: "ping",
    });
    const reply = await service.post(A, { text: "pong", replyTo: mine.id });
    expect(reply.replyTo).toBe(mine.id);
  });

  it("rejects a malformed replyTo before touching the database", async () => {
    await expect(
      service.post(A, { text: "x", replyTo: "not-a-uuid" })
    ).rejects.toThrow(/replyTo/);
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
    await expect(
      service.update(A, "not-a-uuid", { text: "x" })
    ).rejects.toThrow(/messageId/);

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

describe("ChatService.update on an answered question", () => {
  async function answeredQuestion(): Promise<ChatMessage> {
    const q = await service.post(A, {
      text: "Ship it?",
      kind: "question",
      question: { options: [{ label: "Yes", value: "yes" }, { label: "No" }] },
    });
    await service.store.recordAnswer(q.id, {
      value: "yes",
      label: "Yes",
      replyMessageId: q.id,
      answeredAt: new Date().toISOString(),
    });
    return (await service.store.getById(q.id))!;
  }

  it("refuses to change the kind once the question is answered", async () => {
    const q = await answeredQuestion();
    await expect(
      service.update(A, q.id, { kind: "update", text: "never mind" })
    ).rejects.toThrow(/already been answered/);
    const after = await service.store.getById(q.id);
    expect(after).toMatchObject({
      kind: "question",
      text: "Ship it?",
      question: q.question,
      answer: q.answer,
    });
  });

  it("refuses to replace the options once the question is answered", async () => {
    const q = await answeredQuestion();
    await expect(
      service.update(A, q.id, {
        question: { options: [{ label: "Maybe", value: "maybe" }] },
      })
    ).rejects.toThrow(/already been answered/);
    expect((await service.store.getById(q.id))?.question).toEqual(q.question);
  });

  it("still lets the text and attachments of an answered question change", async () => {
    const q = await answeredQuestion();
    const updated = await service.update(A, q.id, {
      text: "Ship it? (decided)",
      attachments: [{ type: "link", url: "https://example.com" }],
    });
    expect(updated).toMatchObject({
      kind: "question",
      text: "Ship it? (decided)",
      question: q.question,
      answer: q.answer,
      attachments: [{ type: "link", url: "https://example.com" }],
    });
    // Restating the current kind is not a change.
    await expect(
      service.update(A, q.id, { kind: "question", text: "again" })
    ).resolves.toMatchObject({ text: "again" });
  });
});

describe("ChatService user workflows", () => {
  type Injected = { agentId: string; sessionName: string; text: string };

  function build(
    opts: {
      access?: ChatDeliveryAdapter["access"];
      held?: boolean;
      /** Resolve to release deliveries; absent = deliver immediately. */
      gate?: Promise<void>;
      fail?: boolean;
    } = {}
  ) {
    const events: unknown[] = [];
    const injected: Injected[] = [];
    const svc = new ChatService({
      pool,
      publishUiEvent: (event) => events.push(event),
      getAgent: async (id) =>
        id === A
          ? { id, mediaDir: "/custom/media", pins: PINS as never }
          : null,
      mediaRoot: "/media-root",
      delivery: {
        access:
          opts.access ??
          (async () => ({ mode: "tmux" as const, sessionName: "sess" })),
        inject: async (agentId, sessionName, text) => {
          if (opts.gate) await opts.gate;
          injected.push({ agentId, sessionName, text });
          if (opts.fail) throw new Error("pane gone");
        },
        held: () => opts.held ?? false,
      },
    });
    return { svc, events, injected };
  }

  async function settled(svc: ChatService, id: string): Promise<ChatMessage> {
    for (let i = 0; i < 50; i++) {
      const row = await svc.store.getById(id);
      if (row && row.delivered !== null) return row;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("delivery never settled");
  }

  it("sendUserMessage persists pending, returns held, then settles delivered", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { svc, events, injected } = build({ held: true, gate });
    const res = await svc.sendUserMessage(A, "do the thing");
    expect(res).toMatchObject({
      delivered: null,
      held: true,
      message: { authorKind: "user", kind: "reply", delivered: null },
    });
    expect(injected).toHaveLength(0);
    expect(events).toEqual([{ type: "chat.changed", agentId: A }]);
    expect(svc.inFlightDeliveryCount).toBe(1);

    release();
    const row = await settled(svc, res.message.id);
    expect(row.delivered).toBe(true);
    expect(injected[0]).toMatchObject({ agentId: A, sessionName: "sess" });
    expect(injected[0].text).toContain(`(id: ${res.message.id})`);
    expect(injected[0].text).toContain("\ndo the thing\n");
    expect(events).toHaveLength(2);
    expect(await svc.waitForInFlightDeliveries(1_000)).toBe(true);
    expect(svc.inFlightDeliveryCount).toBe(0);
  });

  it("sendUserMessage records delivered=false when the pane write fails", async () => {
    const { svc } = build({ fail: true });
    const res = await svc.sendUserMessage(A, "hello");
    expect((await settled(svc, res.message.id)).delivered).toBe(false);
  });

  it("sendUserMessage rejects empty/oversized text and an undeliverable agent", async () => {
    const { svc } = build({
      access: async () => ({ mode: "inert", message: "No pane." }),
    });
    await expect(svc.sendUserMessage(A, "   ")).rejects.toBeInstanceOf(
      ChatValidationError
    );
    await expect(
      svc.sendUserMessage(A, "x".repeat(20_001))
    ).rejects.toBeInstanceOf(ChatValidationError);
    await expect(svc.sendUserMessage(A, "hi")).rejects.toThrow(
      new ChatConflictError("No pane.")
    );
    // Nothing was written for any of them.
    const rows = await pool.query("SELECT 1 FROM agent_chat_messages");
    expect(rows.rowCount).toBe(0);
  });

  it("sendUserMessage resolves user attachments and lists them in the envelope", async () => {
    await pool.query(
      `INSERT INTO media (agent_id, file_name, source, size_bytes)
       VALUES ($1, 'shot-2026-01-01-00-00-00-000.png', 'user', 122880)`,
      [A]
    );
    const media = await pool.query<{ id: number }>(
      `SELECT id FROM media WHERE agent_id = $1`,
      [A]
    );
    const mediaId = media.rows[0].id;
    const { svc, injected } = build();
    const res = await svc.sendUserMessage(A, "look at this", [
      { type: "file", mediaId },
      { type: "pin", pinId: "pin_1" },
      { type: "link", url: "https://example.com/spec", title: "Spec" },
    ]);
    expect(res.message.attachments).toEqual([
      {
        type: "file",
        mediaId,
        fileName: "shot-2026-01-01-00-00-00-000.png",
        sizeBytes: 122880,
        mimeType: "image/png",
      },
      { type: "pin", pinId: "pin_1" },
      { type: "link", url: "https://example.com/spec", title: "Spec" },
    ]);
    await settled(svc, res.message.id);
    expect(injected[0].text).toBe(
      [
        `--- DISPATCH CHAT (id: ${res.message.id}) ---`,
        "look at this",
        "",
        "Attachments:",
        "- file: /custom/media/shot-2026-01-01-00-00-00-000.png (image/png, 120 KB)",
        "- pin: URL — http://x",
        "- link: https://example.com/spec — Spec",
        "--- END DISPATCH CHAT ---",
        `The user is reading the Chat tab, not this terminal — they only see what you post with dispatch_chat_post. Reply there (replyTo: "${res.message.id}"); terminal output alone will not reach them.`,
      ].join("\n")
    );
  });

  it("sendUserMessage accepts blank text with an attachment and lists only the attachments", async () => {
    const { svc, injected } = build();
    const res = await svc.sendUserMessage(A, "", [
      { type: "link", url: "https://example.com" },
    ]);
    expect(res.message.text).toBe("");
    await settled(svc, res.message.id);
    expect(injected[0].text).toContain(
      `--- DISPATCH CHAT (id: ${res.message.id}) ---\nAttachments:\n- link: https://example.com\n--- END DISPATCH CHAT ---`
    );
  });

  it("sendUserMessage rejects unknown media, foreign pins, and too many attachments before writing", async () => {
    const { svc, injected } = build();
    await expect(
      svc.sendUserMessage(A, "x", [{ type: "file", mediaId: 999_999 }])
    ).rejects.toThrow(/Unknown file #999999/);
    await expect(
      svc.sendUserMessage(A, "x", [{ type: "pin", pinId: "pin_nope" }])
    ).rejects.toThrow(/Unknown pin/);
    await expect(
      svc.sendUserMessage(
        A,
        "x",
        Array.from({ length: 21 }, () => ({
          type: "link" as const,
          url: "https://example.com",
        }))
      )
    ).rejects.toThrow(/20 entries or fewer/);
    const rows = await pool.query("SELECT 1 FROM agent_chat_messages");
    expect(rows.rowCount).toBe(0);
    expect(injected).toHaveLength(0);
  });

  it("answerQuestion resolves the option label, records the answer, and delivers", async () => {
    const { svc, injected, events } = build();
    const q = await svc.post(A, {
      text: "Ship it?",
      kind: "question",
      question: { options: [{ label: "Yes", value: "yes" }, { label: "No" }] },
    });
    events.length = 0;
    const res = await svc.answerQuestion(A, q.id, {
      value: "yes",
      label: "ignored for option answers",
    });
    expect(res.delivered).toBeNull();
    expect(res.reply).toMatchObject({
      authorKind: "user",
      text: "Yes",
      replyTo: q.id,
      delivered: null,
    });
    expect(res.question.answer).toMatchObject({
      value: "yes",
      label: "Yes",
      replyMessageId: res.reply.id,
    });
    expect(events[0]).toEqual({ type: "chat.changed", agentId: A });
    expect((await settled(svc, res.reply.id)).delivered).toBe(true);
    expect(injected[0].text).toContain("\nYes\n");

    await expect(
      svc.answerQuestion(A, q.id, { value: "No" })
    ).rejects.toBeInstanceOf(ChatConflictError);
  });

  it("answerQuestion maps missing, foreign, non-question, and bad values to domain errors", async () => {
    const { svc } = build();
    await expect(
      svc.answerQuestion(A, "not-a-uuid", { value: "a" })
    ).rejects.toBeInstanceOf(ChatValidationError);
    await expect(
      svc.answerQuestion(A, "00000000-0000-4000-8000-000000000000", {
        value: "a",
      })
    ).rejects.toBeInstanceOf(ChatNotFoundError);
    const plain = await svc.post(A, { text: "not a question" });
    await expect(
      svc.answerQuestion(A, plain.id, { value: "a" })
    ).rejects.toBeInstanceOf(ChatNotFoundError);
    const q = await svc.post(A, {
      text: "?",
      kind: "question",
      question: { options: [{ label: "a" }] },
    });
    await expect(
      svc.answerQuestion("agt_someone_else", q.id, { value: "a" })
    ).rejects.toBeInstanceOf(ChatNotFoundError);
    await expect(
      svc.answerQuestion(A, q.id, { value: "  " })
    ).rejects.toBeInstanceOf(ChatValidationError);
    await expect(
      svc.answerQuestion(A, q.id, { value: "typed" })
    ).rejects.toThrow(/does not match/);
    expect((await svc.store.getById(q.id))?.answer).toBeNull();
  });

  it("answerQuestion accepts a freeform answer with a trimmed label", async () => {
    const { svc } = build();
    const q = await svc.post(A, {
      text: "?",
      kind: "question",
      question: { options: [{ label: "a" }], allowFreeform: true },
    });
    const res = await svc.answerQuestion(A, q.id, {
      value: "something typed",
      label: "  typed  ",
    });
    expect(res.reply.text).toBe("something typed");
    expect(res.question.answer).toMatchObject({
      value: "something typed",
      label: "typed",
    });
  });

  it("answerQuestion stores attachments on the reply and lists them in the envelope", async () => {
    await pool.query(
      `INSERT INTO media (agent_id, file_name, source, size_bytes)
       VALUES ($1, 'shot-2026-01-01-00-00-00-000.png', 'user', 122880)`,
      [A]
    );
    const media = await pool.query<{ id: number }>(
      `SELECT id FROM media WHERE agent_id = $1`,
      [A]
    );
    const mediaId = media.rows[0].id;
    const { svc, injected } = build();
    const q = await svc.post(A, {
      text: "Which one?",
      kind: "question",
      question: { options: [{ label: "a" }], allowFreeform: true },
    });
    const res = await svc.answerQuestion(A, q.id, {
      value: "this one",
      attachments: [
        { type: "file", mediaId },
        { type: "pin", pinId: "pin_1" },
        { type: "link", url: "https://example.com/spec", title: "Spec" },
      ],
    });
    expect(res.reply.replyTo).toBe(q.id);
    expect(res.reply.attachments).toEqual([
      {
        type: "file",
        mediaId,
        fileName: "shot-2026-01-01-00-00-00-000.png",
        sizeBytes: 122880,
        mimeType: "image/png",
      },
      { type: "pin", pinId: "pin_1" },
      { type: "link", url: "https://example.com/spec", title: "Spec" },
    ]);
    expect(res.question.answer).toMatchObject({
      value: "this one",
      replyMessageId: res.reply.id,
    });
    expect((await svc.store.getById(res.reply.id))?.attachments).toEqual(
      res.reply.attachments
    );
    await settled(svc, res.reply.id);
    expect(injected[0].text).toContain(
      [
        `--- DISPATCH CHAT (id: ${res.reply.id}) ---`,
        "this one",
        "",
        "Attachments:",
        "- file: /custom/media/shot-2026-01-01-00-00-00-000.png (image/png, 120 KB)",
        "- pin: URL — http://x",
        "- link: https://example.com/spec — Spec",
        "--- END DISPATCH CHAT ---",
      ].join("\n")
    );
  });

  it("answerQuestion rejects unknown media, foreign pins, and too many attachments before writing", async () => {
    const { svc, injected } = build();
    const q = await svc.post(A, {
      text: "?",
      kind: "question",
      question: { options: [{ label: "a" }], allowFreeform: true },
    });
    await expect(
      svc.answerQuestion(A, q.id, {
        value: "x",
        attachments: [{ type: "file", mediaId: 999_999 }],
      })
    ).rejects.toThrow(/Unknown file #999999/);
    await expect(
      svc.answerQuestion(A, q.id, {
        value: "x",
        attachments: [{ type: "pin", pinId: "pin_nope" }],
      })
    ).rejects.toThrow(/Unknown pin/);
    await expect(
      svc.answerQuestion(A, q.id, {
        value: "x",
        attachments: Array.from({ length: 21 }, () => ({
          type: "link" as const,
          url: "https://example.com",
        })),
      })
    ).rejects.toThrow(/20 entries or fewer/);
    expect((await svc.store.getById(q.id))?.answer).toBeNull();
    const rows = await pool.query(
      "SELECT 1 FROM agent_chat_messages WHERE author_kind = 'user'"
    );
    expect(rows.rowCount).toBe(0);
    expect(injected).toHaveLength(0);
  });

  it("recoverPendingDeliveries sweeps pending user rows and announces each feed", async () => {
    const { svc, events } = build();
    const pending = await svc.store.insert({
      agentId: A,
      authorKind: "user",
      text: "stuck",
      delivered: null,
    });
    const other = await svc.store.insert({
      agentId: "agt_someone_else",
      authorKind: "user",
      text: "stuck too",
      delivered: null,
    });
    const fine = await svc.store.insert({
      agentId: A,
      authorKind: "user",
      text: "ok",
      delivered: true,
    });
    const touched = await svc.recoverPendingDeliveries();
    expect(touched.sort()).toEqual([A, "agt_someone_else"].sort());
    expect((await svc.store.getById(pending.id))?.delivered).toBe(false);
    expect((await svc.store.getById(other.id))?.delivered).toBe(false);
    expect((await svc.store.getById(fine.id))?.delivered).toBe(true);
    expect(events).toEqual(
      expect.arrayContaining([
        { type: "chat.changed", agentId: A },
        { type: "chat.changed", agentId: "agt_someone_else" },
      ])
    );
    expect(events).toHaveLength(2);
    // Nothing pending, nothing published.
    events.length = 0;
    expect(await svc.recoverPendingDeliveries()).toEqual([]);
    expect(events).toEqual([]);
  });

  it("waitForInFlightDeliveries resolves at once with nothing in flight and times out otherwise", async () => {
    const { svc } = build({ gate: new Promise<void>(() => {}) });
    expect(await svc.waitForInFlightDeliveries(5)).toBe(true);
    await svc.sendUserMessage(A, "never lands");
    const started = Date.now();
    expect(await svc.waitForInFlightDeliveries(30)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(svc.inFlightDeliveryCount).toBe(1);
  });
});
