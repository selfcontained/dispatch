import { beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { Block, BlockAuthor } from "@dispatch/shared";

import { useInjectApp } from "./helpers/inject-app.js";
import { BlockStore } from "../src/chat/store.js";
import { StreamService } from "../src/chat/service.js";
import { registerStreamRoutes } from "../src/routes/streams.js";
import { AgentError } from "../src/agents/errors.js";
import { handleAgentError } from "../src/server/http-helpers.js";

const ctx = useInjectApp();

const USER: BlockAuthor = { kind: "user" };
const agentAuthor = (agentId: string): BlockAuthor => ({
  kind: "agent",
  agentId,
});
const NIL = "00000000-0000-4000-8000-000000000000";

async function authedInject(
  method: "GET" | "POST" | "DELETE" | "PATCH",
  url: string,
  payload?: unknown
) {
  const cookie = await ctx.sessionCookie();
  return ctx.app.inject({
    method,
    url,
    // Like the web client, only a request with a body says it is JSON.
    headers: {
      cookie,
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(payload !== undefined ? { payload } : {}),
  });
}

async function createAgent(name: string): Promise<string> {
  const res = await authedInject("POST", "/api/v1/agents", {
    cwd: "/tmp",
    useWorktree: false,
    name,
  });
  expect(res.statusCode).toBe(201);
  return res.json().agent.id as string;
}

let agentId: string;
let store: BlockStore;

/** Rows a launch writes about itself, which no message assertion wants. */
const STARTUP_ORIGINS = ["system_prompt", "workspace"];

function question(
  streamId: string,
  extra: {
    allowFreeform?: boolean;
    options?: Array<{ label: string; value?: string }>;
  } = {}
) {
  return store.insert({
    streamId,
    author: agentAuthor(streamId),
    kind: "question",
    text: "?",
    data: {
      options: extra.options ?? [{ label: "a" }],
      ...(extra.allowFreeform ? { allowFreeform: true } : {}),
    },
    state: {},
  });
}

function form(streamId: string) {
  return store.insert({
    streamId,
    author: agentAuthor(streamId),
    kind: "form",
    text: "Details",
    data: {
      fields: [
        { id: "name", label: "Name", type: "text", required: true },
        { id: "count", label: "Count", type: "number" },
      ],
    },
    state: {},
  });
}

function review(streamId: string) {
  return store.insert({
    streamId,
    author: agentAuthor(streamId),
    kind: "review",
    data: {
      verdict: "request_changes",
      summary: "s",
      findings: [{ id: "f1", severity: "major", title: "a", body: "b" }],
    },
    state: { findings: { f1: { status: "open", by: USER, at: "t0" } } },
  });
}

beforeEach(async () => {
  await ctx.pool.query("DELETE FROM blocks");
  await ctx.pool.query("DELETE FROM agent_stream_events");
  await ctx.pool.query("DELETE FROM files");
  await ctx.pool.query("DELETE FROM job_runs");
  await ctx.pool.query("DELETE FROM jobs");
  await ctx.pool.query("DELETE FROM agents");
  agentId = await createAgent("Streamy");
  store = new BlockStore(ctx.pool);
});

describe("GET /api/v1/streams/:rootId/blocks", () => {
  it("404s for an unknown agent", async () => {
    const res = await authedInject("GET", "/api/v1/streams/agt_nope/blocks");
    expect(res.statusCode).toBe(404);
  });

  it("validates cursor and limit", async () => {
    const badCursor = await authedInject(
      "GET",
      `/api/v1/streams/${agentId}/blocks?cursor=garbage`
    );
    expect(badCursor.statusCode).toBe(400);
    // Forged but well-formed base64 cursors must be 400s, never SQL casts.
    const forged = [
      { at: "2026-01-01 00:00:00.000000", type: "block", id: "x" },
      { at: "2026-01-01 00:00:00.000000", type: "chat", id: NIL },
      { at: "2026-01-01 00:00:00.000000", type: "status", id: "abc" },
      { at: "2026-02-30 00:00:00.000000", type: "status", id: "1" },
      { at: "2026-01-01 00:00:00.000000", type: "file", id: "99999999999" },
      { at: "0000-01-01 00:00:00.000000", type: "status", id: "1" },
    ];
    for (const value of forged) {
      const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
      const res = await authedInject(
        "GET",
        `/api/v1/streams/${agentId}/blocks?cursor=${encodeURIComponent(encoded)}`
      );
      expect(res.statusCode, JSON.stringify(value)).toBe(400);
      expect(res.json().error).toMatch(/cursor/);
    }
    const badLimit = await authedInject(
      "GET",
      `/api/v1/streams/${agentId}/blocks?limit=lots`
    );
    expect(badLimit.statusCode).toBe(400);
  });

  it("pages with the returned cursor", async () => {
    for (let i = 0; i < 3; i++) {
      await store.insert({
        streamId: agentId,
        author: agentAuthor(agentId),
        text: `m${i}`,
      });
    }
    const first = await authedInject(
      "GET",
      `/api/v1/streams/${agentId}/blocks?limit=2`
    );
    expect(first.statusCode).toBe(200);
    expect(first.json().hasMore).toBe(true);
    expect(typeof first.json().nextCursor).toBe("string");
    const second = await authedInject(
      "GET",
      `/api/v1/streams/${agentId}/blocks?limit=2&cursor=${encodeURIComponent(first.json().nextCursor)}`
    );
    expect(second.statusCode).toBe(200);
    const ids = (r: { json: () => { entries: Array<{ id: string }> } }) =>
      r.json().entries.map((e) => e.id);
    // Paging never repeats a row and never invents one: the two pages are
    // distinct entries, each of them in the stream's own list. The count is
    // not asserted — a launched agent's stream also holds the record of the
    // instructions it started with.
    const paged = [...ids(first), ...ids(second)];
    expect(new Set(paged).size).toBe(paged.length);
    const all = ids(
      await authedInject("GET", `/api/v1/streams/${agentId}/blocks?limit=50`)
    );
    expect(paged.every((id) => all.includes(id))).toBe(true);
  });

  it("returns the composed feed with unreadCount and reply counts", async () => {
    const root = await store.insert({
      streamId: agentId,
      author: agentAuthor(agentId),
      text: "hi there",
    });
    await store.insert({
      streamId: agentId,
      author: USER,
      toAgentId: agentId,
      threadId: root.id,
      replyTo: root.id,
      text: "reply",
      delivered: true,
    });
    const res = await authedInject("GET", `/api/v1/streams/${agentId}/blocks`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
    expect(body.unreadCount).toBe(1);
    const blocks = body.entries.filter(
      (e: { type: string; block: { origin?: string } }) =>
        e.type === "block" && !STARTUP_ORIGINS.includes(e.block.origin ?? "")
    );
    // Creating the agent records what it was told and its workspace coming
    // up; neither is conversation. The reply stays in its thread.
    expect(blocks).toEqual([
      expect.objectContaining({
        id: root.id,
        block: expect.objectContaining({ text: "hi there", replyCount: 1 }),
      }),
    ]);
  });

  it("rejects an unauthenticated request", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/streams/${agentId}/blocks`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/v1/streams/:rootId/blocks/:blockId/thread", () => {
  it("returns the root and its replies oldest first", async () => {
    const root = await store.insert({
      streamId: agentId,
      author: agentAuthor(agentId),
      text: "root",
    });
    const r1 = await store.insert({
      streamId: agentId,
      author: USER,
      toAgentId: agentId,
      threadId: root.id,
      replyTo: root.id,
      text: "r1",
      delivered: true,
    });
    const r2 = await store.insert({
      streamId: agentId,
      author: agentAuthor(agentId),
      threadId: root.id,
      replyTo: r1.id,
      text: "r2",
    });
    const res = await authedInject(
      "GET",
      `/api/v1/streams/${agentId}/blocks/${root.id}/thread`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      root: expect.objectContaining({ id: root.id }),
      replies: [
        expect.objectContaining({ id: r1.id, replyTo: root.id }),
        expect.objectContaining({ id: r2.id, replyTo: r1.id }),
      ],
      agentNames: { [agentId]: expect.any(String) },
    });
  });

  it("names an archived agent that replied in the thread", async () => {
    const helper = await createAgent("Helper that left");
    const root = await store.insert({
      streamId: agentId,
      author: agentAuthor(agentId),
      text: "root",
    });
    await store.insert({
      streamId: agentId,
      author: agentAuthor(helper),
      threadId: root.id,
      replyTo: root.id,
      text: "done, archiving myself",
    });
    await ctx.pool.query("UPDATE agents SET deleted_at = NOW() WHERE id = $1", [
      helper,
    ]);
    const res = await authedInject(
      "GET",
      `/api/v1/streams/${agentId}/blocks/${root.id}/thread`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().agentNames).toMatchObject({
      [helper]: "Helper that left",
    });
  });

  it("400s a malformed id and 404s a reply, an unknown block, or another stream's", async () => {
    const root = await store.insert({
      streamId: agentId,
      author: agentAuthor(agentId),
      text: "root",
    });
    const reply = await store.insert({
      streamId: agentId,
      author: USER,
      toAgentId: agentId,
      threadId: root.id,
      replyTo: root.id,
      text: "r1",
    });
    const get = (id: string, stream = agentId) =>
      authedInject("GET", `/api/v1/streams/${stream}/blocks/${id}/thread`);
    expect((await get("nope")).statusCode).toBe(400);
    expect((await get(reply.id)).statusCode).toBe(404);
    expect((await get(NIL)).statusCode).toBe(404);
    expect((await get(root.id, "agt_other")).statusCode).toBe(404);
  });
});

describe("POST /api/v1/streams/:rootId/blocks (inert runtime)", () => {
  it("400s on missing or oversized text", async () => {
    const empty = await authedInject(
      "POST",
      `/api/v1/streams/${agentId}/blocks`,
      {
        text: "   ",
      }
    );
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toMatch(/text is required/);
    const big = await authedInject(
      "POST",
      `/api/v1/streams/${agentId}/blocks`,
      {
        text: "x".repeat(20_001),
      }
    );
    expect(big.statusCode).toBe(400);
    expect(big.json().error).toMatch(/20000 characters or fewer/);
  });

  it("400s malformed, oversized, or path-based attachment lists", async () => {
    const url = `/api/v1/streams/${agentId}/blocks`;
    const tooMany = await authedInject("POST", url, {
      text: "x",
      attachments: Array.from({ length: 21 }, () => ({
        type: "link",
        url: "https://example.com",
      })),
    });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().error).toMatch(/attachments/);
    // The user path takes files by fileId only; fileName and path are the agent's.
    for (const file of [
      { type: "file", fileName: "shot.png" },
      { type: "file", path: "/tmp/shot.png" },
    ]) {
      const res = await authedInject("POST", url, {
        text: "x",
        attachments: [file],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/attachments\.0/);
    }
    const badKind = await authedInject("POST", url, {
      text: "x",
      attachments: [{ type: "code", code: "x" }],
    });
    expect(badKind.statusCode).toBe(400);
    const badUrl = await authedInject("POST", url, {
      text: "x",
      attachments: [{ type: "link", url: "not a url" }],
    });
    expect(badUrl.statusCode).toBe(400);
    for (const scheme of [
      "javascript:alert(1)",
      "data:text/html,hi",
      "file:///etc/passwd",
      "ftp://example.com/x",
    ]) {
      const badScheme = await authedInject("POST", url, {
        text: "x",
        attachments: [{ type: "link", url: scheme }],
      });
      expect(badScheme.statusCode).toBe(400);
      expect(badScheme.json().error).toMatch(/http or https/);
    }
    const oversizedUrl = await authedInject("POST", url, {
      text: "x",
      attachments: [
        { type: "link", url: `https://example.com/${"a".repeat(2100)}` },
      ],
    });
    expect(oversizedUrl.statusCode).toBe(400);
    expect(oversizedUrl.json().error).toMatch(/2048 characters or fewer/);
    const notArray = await authedInject("POST", url, {
      text: "x",
      attachments: { type: "link", url: "https://example.com" },
    });
    expect(notArray.statusCode).toBe(400);
    const blank = await authedInject("POST", url, {
      text: "",
      attachments: [],
    });
    expect(blank.statusCode).toBe(400);
    expect(blank.json().error).toMatch(/text is required/);
    const unknownFile = await authedInject("POST", url, {
      text: "",
      attachments: [{ type: "file", fileId: 424242 }],
    });
    expect(unknownFile.statusCode).toBe(400);
    expect(unknownFile.json().error).toMatch(/Unknown file/);
    const badReply = await authedInject("POST", url, {
      text: "x",
      replyTo: "nope",
    });
    expect(badReply.statusCode).toBe(400);
    const unknownReply = await authedInject("POST", url, {
      text: "x",
      replyTo: NIL,
    });
    expect(unknownReply.statusCode).toBe(400);
    expect(unknownReply.json().error).toMatch(/replyTo/);
    const badId = await authedInject("POST", url, {
      id: "not-a-uuid",
      text: "x",
    });
    expect(badId.statusCode).toBe(400);
    // Nothing was written by any of the rejected posts; the system-prompt
    // record the launch wrote is not one of them.
    const rows = await ctx.pool.query(
      `SELECT 1 FROM blocks
        WHERE stream_id = $1 AND (origin IS NULL OR origin NOT IN ('system_prompt', 'workspace'))`,
      [agentId]
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("stores an undelivered block when the agent is inert", async () => {
    const res = await authedInject(
      "POST",
      `/api/v1/streams/${agentId}/blocks`,
      {
        text: "hello?",
      }
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      delivered: false,
      held: false,
      block: {
        author: { kind: "user" },
        toAgentId: agentId,
        kind: "text",
        text: "hello?",
        delivered: false,
      },
    });
    // The agent's own stream also holds the system-prompt record written at
    // launch; this is about what the post stored.
    const rows = await ctx.pool.query(
      `SELECT text, delivered, to_agent_id FROM blocks
        WHERE stream_id = $1 AND (origin IS NULL OR origin NOT IN ('system_prompt', 'workspace'))`,
      [agentId]
    );
    expect(rows.rows).toEqual([
      { text: "hello?", delivered: false, to_agent_id: agentId },
    ]);
  });

  it("threads a reply and addresses a post to another agent on the stream", async () => {
    const other = await createAgent("Other");
    const root = await store.insert({
      streamId: agentId,
      author: agentAuthor(agentId),
      text: "root",
    });
    const reply = await authedInject(
      "POST",
      `/api/v1/streams/${agentId}/blocks`,
      {
        text: "in thread",
        replyTo: root.id,
      }
    );
    expect(reply.statusCode).toBe(200);
    expect(reply.json().block).toMatchObject({
      threadId: root.id,
      replyTo: root.id,
    });
    const addressed = await authedInject(
      "POST",
      `/api/v1/streams/${agentId}/blocks`,
      {
        text: "for the other one",
        to: other,
      }
    );
    expect(addressed.statusCode).toBe(200);
    expect(addressed.json().block).toMatchObject({
      streamId: agentId,
      toAgentId: other,
    });
    const unknownTo = await authedInject(
      "POST",
      `/api/v1/streams/${agentId}/blocks`,
      {
        text: "x",
        to: "agt_nobody",
      }
    );
    expect(unknownTo.statusCode).toBe(400);
  });

  it("404s for an unknown agent", async () => {
    const res = await authedInject("POST", "/api/v1/streams/agt_nope/blocks", {
      text: "hello?",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/v1/streams/:rootId/blocks/:blockId/answer (inert runtime)", () => {
  it("400s a malformed blockId without querying", async () => {
    const res = await authedInject(
      "POST",
      `/api/v1/streams/${agentId}/blocks/not-a-uuid/answer`,
      { value: "a" }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/UUID/);
  });

  it("400s a value that matches no option on a closed question", async () => {
    const q = await question(agentId);
    const res = await authedInject(
      "POST",
      `/api/v1/streams/${agentId}/blocks/${q.id}/answer`,
      { value: "zzz" }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/options/);
    expect((await store.getById(q.id))?.state).toEqual({});
  });

  it("404s when the block is not a question on this stream", async () => {
    const plain = await store.insert({
      streamId: agentId,
      author: agentAuthor(agentId),
      text: "plain",
    });
    const res = await authedInject(
      "POST",
      `/api/v1/streams/${agentId}/blocks/${plain.id}/answer`,
      { value: "a" }
    );
    expect(res.statusCode).toBe(404);
    const q = await question(agentId);
    const foreign = await authedInject(
      "POST",
      `/api/v1/streams/agt_other/blocks/${q.id}/answer`,
      { value: "a" }
    );
    expect(foreign.statusCode).toBe(404);
  });

  it("409s once a question is answered, before checking deliverability", async () => {
    const q = await question(agentId);
    await store.recordAnswer(q.id, {
      value: "a",
      by: USER,
      blockId: q.id,
      at: new Date().toISOString(),
    });
    const res = await authedInject(
      "POST",
      `/api/v1/streams/${agentId}/blocks/${q.id}/answer`,
      { value: "a" }
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already answered/i);
  });

  it("records an undelivered answer when there is no engine", async () => {
    const q = await question(agentId);
    const res = await authedInject(
      "POST",
      `/api/v1/streams/${agentId}/blocks/${q.id}/answer`,
      { value: "a" }
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      delivered: false,
      block: { id: q.id, state: { answer: { value: "a", label: "a" } } },
      reply: { text: "a", delivered: false, threadId: q.id, replyTo: q.id },
    });
  });

  it("400s an answer without a value or with a non-string label", async () => {
    const q = await question(agentId);
    const missing = await authedInject(
      "POST",
      `/api/v1/streams/${agentId}/blocks/${q.id}/answer`,
      {}
    );
    expect(missing.statusCode).toBe(400);
    const badLabel = await authedInject(
      "POST",
      `/api/v1/streams/${agentId}/blocks/${q.id}/answer`,
      { value: "a", label: 7 }
    );
    expect(badLabel.statusCode).toBe(400);
  });
});

describe("POST /api/v1/streams/:rootId/blocks/:blockId/submit (inert runtime)", () => {
  it("records an undelivered submission with the values the form declares", async () => {
    const f = await form(agentId);
    const res = await authedInject(
      "POST",
      `/api/v1/streams/${agentId}/blocks/${f.id}/submit`,
      { values: { name: "Ada", count: 3, stray: "dropped" } }
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      delivered: false,
      block: {
        id: f.id,
        state: {
          submission: {
            values: { name: "Ada", count: 3 },
            by: { kind: "user" },
          },
        },
      },
      reply: { text: "Name: Ada\nCount: 3", delivered: false, replyTo: f.id },
    });
    const again = await authedInject(
      "POST",
      `/api/v1/streams/${agentId}/blocks/${f.id}/submit`,
      { values: { name: "B" } }
    );
    expect(again.statusCode).toBe(409);
  });

  it("400s a missing required field or a malformed body, and 404s a non-form", async () => {
    const f = await form(agentId);
    const url = `/api/v1/streams/${agentId}/blocks/${f.id}/submit`;
    const missing = await authedInject("POST", url, { values: { count: 1 } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toMatch(/"Name" is required/);
    const noValues = await authedInject("POST", url, {});
    expect(noValues.statusCode).toBe(400);
    const badType = await authedInject("POST", url, {
      values: { name: { nested: 1 } },
    });
    expect(badType.statusCode).toBe(400);
    const badId = await authedInject("POST", url, {
      id: "nope",
      values: { name: "x" },
    });
    expect(badId.statusCode).toBe(400);
    expect((await store.getById(f.id))?.state).toEqual({});
    const q = await question(agentId);
    const notForm = await authedInject(
      "POST",
      `/api/v1/streams/${agentId}/blocks/${q.id}/submit`,
      { values: {} }
    );
    expect(notForm.statusCode).toBe(404);
    const unknown = await authedInject(
      "POST",
      `/api/v1/streams/${agentId}/blocks/nope/submit`,
      { values: {} }
    );
    expect(unknown.statusCode).toBe(404);
  });
});

describe("PATCH /api/v1/streams/:rootId/blocks/:blockId/state (inert runtime)", () => {
  it("resolves a finding as the user and returns the block", async () => {
    const r = await review(agentId);
    const res = await authedInject(
      "PATCH",
      `/api/v1/streams/${agentId}/blocks/${r.id}/state`,
      { state: { findings: { f1: "fixed" } } }
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      block: expect.objectContaining({
        id: r.id,
        state: {
          findings: {
            f1: {
              status: "resolved",
              resolution: "fixed",
              by: { kind: "user" },
              at: expect.any(String),
            },
          },
        },
      }),
    });
    const tasks = await store.insert({
      streamId: agentId,
      author: agentAuthor(agentId),
      kind: "tasks",
      data: { items: [{ id: "t1", text: "a" }] },
      state: { items: { t1: "todo" } },
    });
    const ticked = await authedInject(
      "PATCH",
      `/api/v1/streams/${agentId}/blocks/${tasks.id}/state`,
      { state: { items: { t1: "done" } } }
    );
    expect(ticked.json().block.state).toEqual({ items: { t1: "done" } });
  });

  it("400s a bad body or a stateless kind and 404s unknown or foreign blocks", async () => {
    const r = await review(agentId);
    const url = `/api/v1/streams/${agentId}/blocks/${r.id}/state`;
    expect((await authedInject("PATCH", url, {})).statusCode).toBe(400);
    expect(
      (await authedInject("PATCH", url, { state: "resolved" })).statusCode
    ).toBe(400);
    const badStatus = await authedInject("PATCH", url, {
      state: { findings: { f1: "disputed" } },
    });
    expect(badStatus.statusCode).toBe(400);
    expect(badStatus.json().error).toMatch(/open, fixed or dismissed/);
    const text = await store.insert({
      streamId: agentId,
      author: agentAuthor(agentId),
      text: "plain",
    });
    const stateless = await authedInject(
      "PATCH",
      `/api/v1/streams/${agentId}/blocks/${text.id}/state`,
      { state: { items: {} } }
    );
    expect(stateless.statusCode).toBe(400);
    expect(stateless.json().error).toMatch(/has no state/);
    expect(
      (
        await authedInject(
          "PATCH",
          `/api/v1/streams/${agentId}/blocks/${NIL}/state`,
          {
            state: { findings: {} },
          }
        )
      ).statusCode
    ).toBe(404);
    expect(
      (
        await authedInject(
          "PATCH",
          `/api/v1/streams/agt_other/blocks/${r.id}/state`,
          {
            state: { findings: {} },
          }
        )
      ).statusCode
    ).toBe(404);
    expect((await store.getById(r.id))?.state).toEqual(r.state);
  });
});

describe("stream reaction routes (inert runtime)", () => {
  async function agentPost(): Promise<Block> {
    return store.insert({
      streamId: agentId,
      author: agentAuthor(agentId),
      text: "Done.",
    });
  }

  it("adds a reaction as not delivered and shows it on the feed row", async () => {
    const block = await agentPost();
    const res = await authedInject(
      "POST",
      `/api/v1/streams/${agentId}/blocks/${block.id}/reactions`,
      { emoji: "👍" }
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      blockId: block.id,
      reactions: [
        {
          id: expect.any(String),
          author: { kind: "user" },
          emoji: "👍",
          delivered: false,
          createdAt: expect.any(String),
        },
      ],
    });
    const feed = await authedInject("GET", `/api/v1/streams/${agentId}/blocks`);
    const entry = feed
      .json()
      .entries.find((e: { id: string }) => e.id === block.id);
    expect(entry.block.reactions).toEqual(res.json().reactions);
  });

  it("removes a reaction by its URL-encoded emoji", async () => {
    const block = await agentPost();
    await authedInject(
      "POST",
      `/api/v1/streams/${agentId}/blocks/${block.id}/reactions`,
      { emoji: "❤️" }
    );
    const res = await authedInject(
      "DELETE",
      `/api/v1/streams/${agentId}/blocks/${block.id}/reactions/${encodeURIComponent("❤️")}`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ blockId: block.id, reactions: [] });
  });

  it("400s a bad emoji or block id and 404s a block that takes no reaction", async () => {
    const block = await agentPost();
    const userPost = await store.insert({
      streamId: agentId,
      author: USER,
      toAgentId: agentId,
      text: "mine",
    });
    const post = (id: string, payload: unknown) =>
      authedInject(
        "POST",
        `/api/v1/streams/${agentId}/blocks/${id}/reactions`,
        payload
      );
    expect((await post(block.id, { emoji: "nice" })).statusCode).toBe(400);
    expect((await post(block.id, {})).statusCode).toBe(400);
    expect((await post("nope", { emoji: "👍" })).statusCode).toBe(400);
    expect((await post(userPost.id, { emoji: "👍" })).statusCode).toBe(404);
    const other = await authedInject(
      "POST",
      `/api/v1/streams/agt_nope/blocks/${block.id}/reactions`,
      { emoji: "👍" }
    );
    expect(other.statusCode).toBe(404);
  });
});

describe("POST /api/v1/streams/:rootId/blocks/:blockId/read", () => {
  it("marks the thread's agent replies read and returns their ids", async () => {
    const r = await review(agentId);
    const reply = await store.insert({
      streamId: agentId,
      author: agentAuthor(agentId),
      threadId: r.id,
      replyTo: r.id,
      text: "on it",
      data: { findingId: "f1" },
    });
    const other = await store.insert({
      streamId: agentId,
      author: agentAuthor(agentId),
      threadId: r.id,
      replyTo: r.id,
      text: "general",
    });
    const miss = await authedInject(
      "POST",
      `/api/v1/streams/${agentId}/blocks/${r.id}/read`,
      { finding: "f9" }
    );
    expect(miss.json()).toEqual({ ids: [], readAt: null });
    const one = await authedInject(
      "POST",
      `/api/v1/streams/${agentId}/blocks/${r.id}/read`,
      { finding: "f1" }
    );
    expect(one.json()).toEqual({ ids: [reply.id], readAt: expect.any(String) });
    const all = await authedInject(
      "POST",
      `/api/v1/streams/${agentId}/blocks/${r.id}/read`,
      {}
    );
    expect(all.json()).toEqual({ ids: [other.id], readAt: expect.any(String) });
    expect(
      (
        await authedInject(
          "POST",
          `/api/v1/streams/${agentId}/blocks/nope/read`,
          {}
        )
      ).statusCode
    ).toBe(400);
    expect(
      (
        await authedInject(
          "POST",
          `/api/v1/streams/${agentId}/blocks/${r.id}/read`,
          {
            finding: 3,
          }
        )
      ).statusCode
    ).toBe(400);
  });
});

describe("POST /api/v1/streams/:rootId/read", () => {
  it("marks agent blocks read and returns the new unread count", async () => {
    const first = await store.insert({
      streamId: agentId,
      author: agentAuthor(agentId),
      text: "1",
    });
    await store.insert({
      streamId: agentId,
      author: agentAuthor(agentId),
      text: "2",
    });
    const partial = await authedInject(
      "POST",
      `/api/v1/streams/${agentId}/read`,
      {
        upTo: first.id,
      }
    );
    expect(partial.statusCode).toBe(200);
    expect(partial.json()).toEqual({ unreadCount: 1 });
    const all = await authedInject(
      "POST",
      `/api/v1/streams/${agentId}/read`,
      {}
    );
    expect(all.json()).toEqual({ unreadCount: 0 });
  });

  it("400s a present-but-invalid upTo and treats null as omitted", async () => {
    await store.insert({
      streamId: agentId,
      author: agentAuthor(agentId),
      text: "1",
    });
    for (const upTo of ["nope", 5, {}]) {
      const res = await authedInject(
        "POST",
        `/api/v1/streams/${agentId}/read`,
        { upTo }
      );
      expect(res.statusCode).toBe(400);
    }
    const res = await authedInject("POST", `/api/v1/streams/${agentId}/read`, {
      upTo: null,
    });
    expect(res.json()).toEqual({ unreadCount: 0 });
  });

  it("404s for an unknown agent", async () => {
    const res = await authedInject("POST", "/api/v1/streams/agt_nope/read", {});
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/v1/chat/unread", () => {
  it("lists per-agent unread and open-input counts", async () => {
    const other = await createAgent("Other");
    await store.insert({
      streamId: agentId,
      author: agentAuthor(agentId),
      text: "1",
    });
    await question(agentId);
    await form(agentId);
    const res = await authedInject("GET", "/api/v1/chat/unread");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      agents: { [agentId]: { unread: 3, pendingQuestions: 2 } },
    });
    expect(res.json().agents[other]).toBeUndefined();
  });

  it("rejects an unauthenticated request", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/chat/unread",
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("agent MCP route exposes the stream tools", () => {
  it("lists post, update and react, and none of the retired tools", async () => {
    const authTokenResult = await ctx.pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'auth_token'"
    );
    const authToken = authTokenResult.rows[0]!.value;
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/mcp/${agentId}`,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${ctx.auth.createAgentMcpToken(authToken, agentId)}`,
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(res.statusCode).toBe(200);
    const names: string[] = [];
    for (const line of res.body.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const parsed = JSON.parse(line.slice(5));
      for (const tool of parsed.result?.tools ?? []) names.push(tool.name);
    }
    expect(names).toContain("post");
    expect(names).toContain("update");
    expect(names).toContain("react");
    for (const retired of [
      "chat_post",
      "chat_update",
      "chat_react",
      "share_file",
      "dispatch_share",
      "notify",
    ]) {
      expect(names).not.toContain(retired);
    }
  });
});

// Delivery semantics need a live-looking engine, which the inert runtime
// never provides — so drive the route module directly with a fake access
// check and prompt sender against the same database.
describe("stream routes with a deliverable engine", () => {
  type Sent = { agentId: string; prompt: string };

  function buildApp(opts: {
    sendCommand?: (prompt: string) => Promise<void>;
    held?: boolean;
    access?: () => Promise<{ mode: "live" }>;
    /** Resolve to release a delivery that should stay pending for a while. */
    gate?: Promise<void>;
  }) {
    const published: unknown[] = [];
    const prompts: Sent[] = [];
    const streams = new StreamService({
      pool: ctx.pool,
      publishUiEvent: (event) => published.push(event),
      getAgent: async (id) => ({
        id,
        name: "Streamy",
        status: "running",
        filesDir: null,
      }),
      filesRoot: "/files-root",
      delivery: {
        access: opts.access ?? (async () => ({ mode: "live" as const })),
        inject: async (id: string, prompt: string) => {
          if (opts.gate) await opts.gate;
          prompts.push({ agentId: id, prompt });
          if (opts.sendCommand) await opts.sendCommand(prompt);
        },
        held: () => opts.held ?? false,
      },
    });
    const app = Fastify();
    const ready = registerStreamRoutes(app, {
      pool: ctx.pool,
      streams,
      handleAgentError,
    });
    return { app, ready, streams, published, prompts };
  }

  /**
   * The delivered row, once its whole settlement chain has run: the row
   * is marked before the delivered entry is read back and published, so
   * waiting on the row alone can observe the state between the two.
   */
  async function settled(streams: StreamService, id: string): Promise<Block> {
    for (let i = 0; i < 50; i++) {
      const row = await store.getById(id);
      if (row && row.delivered !== null) {
        await streams.waitForInFlightDeliveries(1_000);
        return row;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("delivery never settled");
  }

  const entryIds = (published: unknown[]) =>
    published.map((e) => {
      const ev = e as { type: string; entry?: { id: string; block?: Block } };
      return [ev.type, ev.entry?.id, ev.entry?.block?.delivered];
    });

  it("stores a post under the client's id and refuses a repeat of it", async () => {
    const { app, ready, published } = buildApp({});
    await ready;
    const id = "7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5";
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/streams/${agentId}/blocks`,
      payload: { id, text: "hello" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().block.id).toBe(id);
    expect(published[0]).toEqual(
      expect.objectContaining({
        type: "stream.entry",
        entry: expect.objectContaining({ id }),
      })
    );
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/streams/${agentId}/blocks`,
      payload: { id, text: "hello again" },
    });
    expect(again.statusCode).toBe(409);
    await app.close();
  });

  it("announces a mark-read with the count and what it stamped", async () => {
    const { app, ready, published } = buildApp({});
    await ready;
    const first = await store.insert({
      streamId: agentId,
      author: agentAuthor(agentId),
      text: "1",
    });
    await store.insert({
      streamId: agentId,
      author: agentAuthor(agentId),
      text: "2",
    });

    const partial = await app.inject({
      method: "POST",
      url: `/api/v1/streams/${agentId}/read`,
      payload: { upTo: first.id },
    });
    expect(partial.json()).toEqual({ unreadCount: 1 });
    // The bound's time travels with the event so a cached feed can stamp
    // the same rows the server did.
    expect(published).toEqual([
      {
        type: "stream.read",
        agentId,
        unreadCount: 1,
        readAt: expect.any(String),
        upToAt: first.createdAt,
      },
    ]);

    published.length = 0;
    const all = await app.inject({
      method: "POST",
      url: `/api/v1/streams/${agentId}/read`,
      payload: {},
    });
    expect(all.json()).toEqual({ unreadCount: 0 });
    expect(published).toEqual([
      expect.objectContaining({
        type: "stream.read",
        unreadCount: 0,
        upToAt: null,
      }),
    ]);

    // Nothing left to mark: nothing announced.
    published.length = 0;
    await app.inject({
      method: "POST",
      url: `/api/v1/streams/${agentId}/read`,
      payload: {},
    });
    expect(published).toEqual([]);
    await app.close();
  });

  it("persists as pending, responds at once, then settles delivered=true", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { app, ready, streams, published, prompts } = buildApp({
      held: true,
      gate,
    });
    await ready;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/streams/${agentId}/blocks`,
      payload: { text: "please do X" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.delivered).toBeNull();
    expect(body.held).toBe(true);
    expect(body.block).toMatchObject({
      author: { kind: "user" },
      toAgentId: agentId,
      kind: "text",
      text: "please do X",
      delivered: null,
    });
    // Still held: nothing has reached the engine and the row is pending.
    expect(prompts).toHaveLength(0);
    expect((await store.getById(body.block.id))?.delivered).toBeNull();
    expect(entryIds(published)).toEqual([
      ["stream.entry", body.block.id, null],
    ]);

    release();
    const row = await settled(streams, body.block.id);
    expect(row.delivered).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].prompt).toBe(
      [
        `--- DISPATCH POST (id: ${body.block.id}, from: user) ---`,
        "please do X",
        "--- END DISPATCH POST ---",
        "Your reply appears in the stream as you write it. Use post only for a question with options, a file, a link, or to reach another agent.",
      ].join("\n")
    );
    // Pending first, then the same row once delivery settled it.
    expect(entryIds(published)).toEqual([
      ["stream.entry", body.block.id, null],
      ["stream.entry", body.block.id, true],
    ]);
    await app.close();
  });

  it("stores user attachments and lists them in the injected envelope", async () => {
    const inserted = await ctx.pool.query<{ id: number }>(
      `INSERT INTO files (agent_id, file_name, source, size_bytes)
       VALUES ($1, 'upload-2026-01-01-00-00-00-000.pdf', 'user', 2048)
       RETURNING id`,
      [agentId]
    );
    const fileId = inserted.rows[0].id;
    const { app, ready, streams, prompts } = buildApp({});
    await ready;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/streams/${agentId}/blocks`,
      payload: {
        text: "",
        attachments: [
          { type: "file", fileId },
          { type: "link", url: "https://example.com/x" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.block.text).toBe("");
    expect(body.block.attachments).toEqual([
      {
        type: "file",
        fileId,
        fileName: "upload-2026-01-01-00-00-00-000.pdf",
        sizeBytes: 2048,
        mimeType: "application/pdf",
        ownerAgentId: agentId,
      },
      { type: "link", url: "https://example.com/x" },
    ]);
    await settled(streams, body.block.id);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].prompt).toContain(
      [
        `--- DISPATCH POST (id: ${body.block.id}, from: user) ---`,
        "Attachments:",
        `- file: /files-root/${agentId}/upload-2026-01-01-00-00-00-000.pdf (application/pdf, 2 KB)`,
        "- link: https://example.com/x",
        "--- END DISPATCH POST ---",
      ].join("\n")
    );
    await app.close();
  });

  it("settles delivered=false when the inject fails after the response", async () => {
    const { app, ready, streams } = buildApp({
      sendCommand: async () => {
        throw new Error("engine gone");
      },
    });
    await ready;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/streams/${agentId}/blocks`,
      payload: { text: "hello" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().delivered).toBeNull();
    const row = await settled(streams, res.json().block.id);
    expect(row.delivered).toBe(false);
    await app.close();
  });

  it("marks a delivery abandoned by a restart as not delivered on recovery", async () => {
    // The quiet gate never releases: this stands in for a process that died
    // with the delivery still queued in memory.
    const { app, ready, streams, published } = buildApp({
      held: true,
      gate: new Promise<void>(() => {}),
    });
    await ready;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/streams/${agentId}/blocks`,
      payload: { text: "lost in the restart" },
    });
    expect(res.statusCode).toBe(200);
    const id = res.json().block.id as string;
    expect((await store.getById(id))?.delivered).toBeNull();
    expect(streams.inFlightDeliveryCount).toBe(1);
    // Shutdown gives it a bounded chance to settle, then gives up.
    expect(await streams.waitForInFlightDeliveries(20)).toBe(false);

    // Next process start.
    published.length = 0;
    expect(await streams.recoverPendingDeliveries()).toEqual([agentId]);
    expect((await store.getById(id))?.delivered).toBe(false);
    expect(published).toEqual([{ type: "stream.changed", agentId }]);
    await app.close();
  });

  it("maps AgentError from the access check through handleAgentError", async () => {
    const { app, ready } = buildApp({
      access: async () => {
        throw new AgentError("Agent is not running.", 409);
      },
    });
    await ready;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/streams/${agentId}/blocks`,
      payload: { text: "hello" },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("answers a question: resolves the option label server-side and injects it", async () => {
    const { app, ready, streams, prompts, published } = buildApp({});
    await ready;
    const q = await question(agentId, {
      options: [{ label: "Yes", value: "yes" }, { label: "No" }],
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/streams/${agentId}/blocks/${q.id}/answer`,
      // A client label that disagrees with the option is ignored.
      payload: { value: "yes", label: "Absolutely" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.delivered).toBeNull();
    expect(body.reply).toMatchObject({
      author: { kind: "user" },
      text: "Yes",
      threadId: q.id,
      replyTo: q.id,
      delivered: null,
    });
    expect(body.block.state.answer).toMatchObject({
      value: "yes",
      label: "Yes",
      by: { kind: "user" },
      blockId: body.reply.id,
    });
    const row = await settled(streams, body.reply.id);
    expect(row.delivered).toBe(true);
    expect(prompts[0].prompt).toContain(`(id: ${body.reply.id}, from: user)`);
    expect(prompts[0].prompt).toContain("\nYes\n");
    expect(prompts[0].prompt).toContain(`This answers your question ${q.id}.`);
    // The answered question first, then the reply (filed into its thread by
    // the client), then the question again as the thread's root.
    expect(entryIds(published).slice(0, 3)).toEqual([
      ["stream.entry", q.id, null],
      ["stream.entry", body.reply.id, null],
      ["stream.entry", q.id, null],
    ]);

    // Value-less options match on their label; but the question is taken.
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/streams/${agentId}/blocks/${q.id}/answer`,
      payload: { value: "No" },
    });
    expect(again.statusCode).toBe(409);
    await app.close();
  });

  it("accepts a typed answer only when allowFreeform is set", async () => {
    const { app, ready } = buildApp({});
    await ready;
    const q = await question(agentId, { allowFreeform: true });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/streams/${agentId}/blocks/${q.id}/answer`,
      payload: { value: "something typed", label: "  typed  " },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reply.text).toBe("something typed");
    expect(res.json().block.state.answer).toMatchObject({
      value: "something typed",
      label: "typed",
    });
    await app.close();
  });

  it("answers with attachments: stores them on the reply and lists them in the envelope", async () => {
    const inserted = await ctx.pool.query<{ id: number }>(
      `INSERT INTO files (agent_id, file_name, source, size_bytes)
       VALUES ($1, 'upload-2026-01-01-00-00-00-000.pdf', 'user', 2048)
       RETURNING id`,
      [agentId]
    );
    const fileId = inserted.rows[0].id;
    const { app, ready, streams, prompts } = buildApp({});
    await ready;
    const q = await question(agentId, { allowFreeform: true });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/streams/${agentId}/blocks/${q.id}/answer`,
      payload: {
        value: "see the doc",
        attachments: [
          { type: "file", fileId },
          { type: "link", url: "https://example.com/x" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reply.replyTo).toBe(q.id);
    expect(body.reply.attachments).toEqual([
      {
        type: "file",
        fileId,
        fileName: "upload-2026-01-01-00-00-00-000.pdf",
        sizeBytes: 2048,
        mimeType: "application/pdf",
        ownerAgentId: agentId,
      },
      { type: "link", url: "https://example.com/x" },
    ]);
    await settled(streams, body.reply.id);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].prompt).toContain(
      [
        `--- DISPATCH POST (id: ${body.reply.id}, from: user) ---`,
        "see the doc",
        "",
        "Attachments:",
        `- file: /files-root/${agentId}/upload-2026-01-01-00-00-00-000.pdf (application/pdf, 2 KB)`,
        "- link: https://example.com/x",
        `This answers your question ${q.id}. In the thread under ${q.id}.`,
        "--- END DISPATCH POST ---",
      ].join("\n")
    );
    await app.close();
  });

  it("400s an answer whose attachments are malformed, unknown, or too many, leaving the question open", async () => {
    const { app, ready, prompts } = buildApp({});
    await ready;
    const q = await question(agentId, { allowFreeform: true });
    const url = `/api/v1/streams/${agentId}/blocks/${q.id}/answer`;
    const unknown = await app.inject({
      method: "POST",
      url,
      payload: { value: "x", attachments: [{ type: "file", fileId: 424242 }] },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toMatch(/Unknown file #424242/);
    const tooMany = await app.inject({
      method: "POST",
      url,
      payload: {
        value: "x",
        attachments: Array.from({ length: 21 }, () => ({
          type: "link",
          url: "https://example.com",
        })),
      },
    });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().error).toMatch(/attachments/);
    const byName = await app.inject({
      method: "POST",
      url,
      payload: {
        value: "x",
        attachments: [{ type: "file", fileName: "a.png" }],
      },
    });
    expect(byName.statusCode).toBe(400);
    expect(byName.json().error).toMatch(/attachments\.0/);
    const badUrl = await app.inject({
      method: "POST",
      url,
      payload: {
        value: "x",
        attachments: [{ type: "link", url: "not a url" }],
      },
    });
    expect(badUrl.statusCode).toBe(400);
    const oversized = await app.inject({
      method: "POST",
      url,
      payload: { value: "x".repeat(20_001) },
    });
    expect(oversized.statusCode).toBe(400);
    expect((await store.getById(q.id))?.state).toEqual({});
    expect(prompts).toHaveLength(0);
    await app.close();
  });

  it("leaves no orphan reply when answers race", async () => {
    const { app, ready } = buildApp({});
    await ready;
    const q = await question(agentId, {
      options: [{ label: "a" }, { label: "b" }],
    });
    const results = await Promise.all(
      ["a", "b", "a", "b"].map((value) =>
        app.inject({
          method: "POST",
          url: `/api/v1/streams/${agentId}/blocks/${q.id}/answer`,
          payload: { value },
        })
      )
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409, 409, 409]);
    const replies = await ctx.pool.query(
      `SELECT id FROM blocks WHERE reply_to = $1`,
      [q.id]
    );
    expect(replies.rows).toHaveLength(1);
    const winner = results.find((r) => r.statusCode === 200)!.json();
    expect(replies.rows[0].id).toBe(winner.reply.id);
    await app.close();
  });

  it("submits a form: injects the values as the reply and settles delivered", async () => {
    const { app, ready, streams, prompts, published } = buildApp({});
    await ready;
    const f = await form(agentId);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/streams/${agentId}/blocks/${f.id}/submit`,
      payload: { values: { name: "Ada", count: 2 } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.delivered).toBeNull();
    expect(body.block.state.submission).toMatchObject({
      values: { name: "Ada", count: 2 },
      blockId: body.reply.id,
    });
    const row = await settled(streams, body.reply.id);
    expect(row.delivered).toBe(true);
    expect(prompts[0].prompt).toContain("\nName: Ada\nCount: 2\n");
    expect(prompts[0].prompt).toContain(`This answers your form ${f.id}.`);
    expect(entryIds(published).slice(0, 3)).toEqual([
      ["stream.entry", f.id, null],
      ["stream.entry", body.reply.id, null],
      ["stream.entry", f.id, null],
    ]);
    // Racing submissions leave one reply.
    const g = await form(agentId);
    const results = await Promise.all(
      ["a", "b", "c"].map((name) =>
        app.inject({
          method: "POST",
          url: `/api/v1/streams/${agentId}/blocks/${g.id}/submit`,
          payload: { values: { name } },
        })
      )
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    const replies = await ctx.pool.query(
      `SELECT id FROM blocks WHERE reply_to = $1`,
      [g.id]
    );
    expect(replies.rows).toHaveLength(1);
    await streams.waitForInFlightDeliveries(1_000);
    await app.close();
  });

  it("tells the author when a person changes a finding's state", async () => {
    const { app, ready, streams, prompts, published } = buildApp({});
    await ready;
    const r = await review(agentId);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/streams/${agentId}/blocks/${r.id}/state`,
      payload: {
        state: {
          findings: {
            f1: {
              status: "resolved",
              resolution: "dismissed",
              note: "Out of scope",
            },
          },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(entryIds(published)).toEqual([["stream.entry", r.id, null]]);
    await streams.waitForInFlightDeliveries(1_000);
    expect(prompts).toEqual([
      {
        agentId,
        prompt: expect.stringContaining(
          `--- DISPATCH POST (id: ${r.id}, from: user) ---\nFinding f1 dismissed: Out of scope\nVerify the resolution`
        ),
      },
    ]);
    await app.close();
  });

  it("delivers a user reaction as a reaction envelope and shows it settled", async () => {
    const { app, ready, streams, prompts, published } = buildApp({});
    await ready;
    const block = await store.insert({
      streamId: agentId,
      author: agentAuthor(agentId),
      text: "Shipped it.",
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/streams/${agentId}/blocks/${block.id}/reactions`,
      payload: { emoji: "🎉" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reactions).toEqual([
      expect.objectContaining({ delivered: null }),
    ]);
    await streams.waitForInFlightDeliveries(1_000);
    expect(prompts[0]?.prompt).toContain(
      `--- DISPATCH REACTION (block id: ${block.id}) ---\nThe user reacted 🎉 to your latest post:\n> Shipped it.`
    );
    const last = published.at(-1) as { entry: { block: Block } };
    expect(last.entry.block.reactions).toEqual([
      expect.objectContaining({ delivered: true }),
    ]);
    await app.close();
  });
});
