import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Pool } from "pg";

import {
  LAUNCH_POST_TRUNCATED_NOTE,
  resolveKindAndData,
  StreamConflictError,
  StreamForbiddenError,
  StreamNotFoundError,
  StreamService,
  type StreamAgent,
  type StreamDeliveryAdapter,
  type StreamServiceDeps,
  StreamValidationError,
  launchBlockId,
} from "../src/chat/service.js";
import type { PromptSource } from "../src/agents/acp/prompt-source.js";
import type { Block } from "@dispatch/shared";
import { BLOCK_ATTACHMENTS_MAX, BLOCK_TEXT_MAX_CHARS } from "@dispatch/shared";
import { composeStreamFeed } from "../src/chat/feed.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;
let service: StreamService;
let published: unknown[];

const A = "agt_stream_svc";
const B = "agt_stream_peer";
const NIL = "00000000-0000-4000-8000-000000000000";
const AGENTS: Record<string, StreamAgent> = {
  [A]: {
    id: A,
    name: "Svc",
    filesDir: null,
    status: "running",
  },
  [B]: {
    id: B,
    name: "Peer",
    filesDir: "/peer/files",
    status: "running",
  },
};
const getAgent = async (id: string) => AGENTS[id] ?? null;

/** The `stream.entry` a write publishes: the block as its own feed row. */
function entryEvent(block: Block): unknown {
  return {
    type: "stream.entry",
    agentId: block.streamId,
    entry: {
      type: "block",
      id: block.id,
      at: block.createdAt,
      block: expect.objectContaining({ id: block.id, text: block.text }),
    },
  };
}

type Injected = { agentId: string; text: string };

function build(
  opts: {
    access?: StreamDeliveryAdapter["access"];
    held?: boolean;
    /** Resolve to release deliveries; absent = deliver immediately. */
    gate?: Promise<void>;
    fail?: boolean;
    /** Agents whose injection throws, for a partial delivery. */
    failFor?: readonly string[];
    deps?: Partial<StreamServiceDeps>;
    withDelivery?: boolean;
    commands?: readonly string[];
  } = {}
) {
  const events: unknown[] = [];
  const injected: Injected[] = [];
  /** What each inject said the prompt is, in step with `injected`. */
  const injectedOpts: Array<
    { blockId?: string; source?: PromptSource; alone?: boolean } | undefined
  > = [];
  const cancelled: string[] = [];
  const svc = new StreamService({
    pool,
    publishUiEvent: (event) => events.push(event),
    getAgent,
    filesRoot: "/files-root",
    ...(opts.withDelivery === false
      ? {}
      : {
          delivery: {
            access: opts.access ?? (async () => ({ mode: "live" as const })),
            inject: async (agentId, text, injectOpts) => {
              if (opts.gate) await opts.gate;
              injected.push({ agentId, text });
              injectedOpts.push(injectOpts);
              if (opts.fail || opts.failFor?.includes(agentId)) {
                throw new Error("engine gone");
              }
            },
            held: () => opts.held ?? false,
            commands: () => opts.commands ?? [],
            cancel: async (agentId) => {
              cancelled.push(agentId);
            },
          },
        }),
    ...opts.deps,
  });
  return { svc, events, injected, injectedOpts, cancelled };
}

/**
 * The delivered row, once its whole settlement chain has run: the row is
 * marked before the delivered entry is read back and published, so waiting
 * on the row alone can observe the state between the two.
 */
async function settled(svc: StreamService, id: string): Promise<Block> {
  for (let i = 0; i < 50; i++) {
    const row = await svc.store.getById(id);
    if (row && row.delivered !== null) {
      await svc.waitForInFlightDeliveries(1_000);
      return row;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("delivery never settled");
}

async function seedFiles(agentId: string, fileName: string, size = 12) {
  // The type these files would have been stored under.
  const mimeType = fileName.endsWith(".png")
    ? "image/png"
    : fileName.endsWith(".md")
      ? "text/markdown"
      : "text/plain";
  const result = await pool.query<{ id: number }>(
    `INSERT INTO files (agent_id, file_name, source, size_bytes, mime_type)
     VALUES ($1, $2, 'user', $3, $4) RETURNING id`,
    [agentId, fileName, size, mimeType]
  );
  return result.rows[0].id;
}

const inert = async () => ({ mode: "inert" as const, message: "No engine." });

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  await pool.query(
    `INSERT INTO agents (id, name, cwd, status)
     VALUES ($1, 'Svc', '/tmp', 'running'), ($2, 'Peer', '/tmp', 'running')`,
    [A, B]
  );
  published = [];
  service = new StreamService({
    pool,
    publishUiEvent: (event) => published.push(event),
    getAgent,
    filesRoot: "/files-root",
  });
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  published.length = 0;
  await pool.query("DELETE FROM blocks");
  await pool.query("DELETE FROM files");
});

// ---------------------------------------------------------------------------
// Launch block
// ---------------------------------------------------------------------------

describe("StreamService.recordLaunchContext", () => {
  it("records one delivered user block with file and link attachments", async () => {
    const fileId = await seedFiles(A, "brief-2026.md", 300);
    const block = await service.recordLaunchContext({
      agentId: A,
      text: "Build the widget",
      files: [{ fileId }],
      links: ["https://example.com/spec"],
    });
    expect(block).toMatchObject({
      id: launchBlockId(A),
      streamId: A,
      author: { kind: "user" },
      toAgentId: A,
      kind: "launch",
      threadId: null,
      text: "Build the widget",
      delivered: true,
      attachments: [
        {
          type: "file",
          fileId,
          fileName: "brief-2026.md",
          sizeBytes: 300,
          mimeType: "text/markdown",
        },
        { type: "link", url: "https://example.com/spec" },
      ],
    });
    expect(block && "launchedByAgentId" in block).toBe(false);
    expect(block && "origin" in block).toBe(false);
    expect(published).toEqual([entryEvent(block!)]);
    expect(await service.store.getById(block!.id)).toEqual(block);
  });

  it("records nothing for a launch with no context", async () => {
    expect(
      await service.recordLaunchContext({ agentId: A, text: "   " })
    ).toBeNull();
    expect(published).toEqual([]);
    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM blocks WHERE stream_id = $1`,
      [A]
    );
    expect(rows.rows[0].n).toBe(0);
  });

  it("attributes the block to the launching agent", async () => {
    const block = await service.recordLaunchContext({
      agentId: A,
      text: "Review the diff",
      launchedByAgentId: B,
    });
    expect(block).toMatchObject({
      author: { kind: "user" },
      kind: "launch",
      launchedByAgentId: B,
      delivered: true,
    });
  });

  it("rejects an unknown file like any user attachment", async () => {
    await expect(
      service.recordLaunchContext({
        agentId: A,
        text: "x",
        files: [{ fileId: 999_999 }],
      })
    ).rejects.toBeInstanceOf(StreamValidationError);
  });
});

describe("StreamService.prepareLaunchContext", () => {
  it("resolves the block's id and envelope lines before anything is written", async () => {
    const fileId = await seedFiles(A, "brief-2026.md", 300);
    const prepared = await service.prepareLaunchContext({
      agentId: A,
      text: "Build the widget",
      files: [{ fileId }],
      links: ["https://example.com/spec"],
    });
    // A new card's id is derived from the agent's.
    expect(prepared?.id).toBe(launchBlockId(A));
    // The same lines sendUserPost injects, so envelope and block agree.
    expect(prepared?.attachmentLines).toEqual([
      "- file: /files-root/agt_stream_svc/brief-2026.md (text/markdown, 300 B)",
      "- link: https://example.com/spec",
    ]);
    // Nothing written and nothing announced until record() runs.
    expect(published).toEqual([]);
    const rows = await pool.query(
      "SELECT id FROM blocks WHERE stream_id = $1",
      [A]
    );
    expect(rows.rows).toHaveLength(0);

    const block = await prepared!.record();
    expect(block.id).toBe(launchBlockId(A));
    expect(block).toMatchObject({
      kind: "launch",
      delivered: true,
      toAgentId: A,
    });
    expect(published).toEqual([entryEvent(block)]);
  });

  it("returns null for a launch with no context", async () => {
    expect(
      await service.prepareLaunchContext({ agentId: A, text: "  " })
    ).toBeNull();
  });

  it("records the launcher on the card for a launch with no briefing, and still returns null", async () => {
    const { svc, events } = build();
    expect(
      await svc.prepareLaunchContext({ agentId: A, launchedByAgentId: B })
    ).toBeNull();
    const card = await svc.store.findLaunchBlock(A);
    expect(card).toMatchObject({
      id: launchBlockId(A),
      kind: "launch",
      toAgentId: A,
      launchedByAgentId: B,
      text: "",
      attachments: [],
    });
    // The change is published so the card reads with its launcher.
    expect(
      events.some(
        (e) =>
          (e as { entry?: { block?: Block } }).entry?.block
            ?.launchedByAgentId === B
      )
    ).toBe(true);
    // With no launcher either, nothing is written at all.
    await pool.query("DELETE FROM blocks");
    expect(await svc.prepareLaunchContext({ agentId: A })).toBeNull();
    expect(await svc.store.findLaunchBlock(A)).toBeNull();
  });

  it("says so in the block when the prompt is longer than a block's text", async () => {
    const prompt = "x".repeat(BLOCK_TEXT_MAX_CHARS + 5_000);
    const prepared = await service.prepareLaunchContext({
      agentId: A,
      text: prompt,
    });
    expect(prepared?.postText.length).toBeLessThanOrEqual(BLOCK_TEXT_MAX_CHARS);
    expect(prepared?.postText).toContain(LAUNCH_POST_TRUNCATED_NOTE);
    const block = await prepared!.record();
    expect(block.text).toBe(prepared?.postText);
    expect(block.text.startsWith("x".repeat(1_000))).toBe(true);
  });

  it("leaves a prompt that fits exactly as written", async () => {
    const prompt = "y".repeat(BLOCK_TEXT_MAX_CHARS);
    const prepared = await service.prepareLaunchContext({
      agentId: A,
      text: prompt,
    });
    expect(prepared?.postText).toBe(prompt);
  });

  it("describes every attachment for the turn while capping the row", async () => {
    const links = Array.from(
      { length: BLOCK_ATTACHMENTS_MAX + 6 },
      (_, i) => `https://example.com/${i}`
    );
    const prepared = await service.prepareLaunchContext({
      agentId: A,
      text: "Build it",
      links,
    });
    expect(prepared?.attachmentLines).toHaveLength(links.length);
    expect(prepared?.attachmentLines?.at(-1)).toBe(`- link: ${links.at(-1)}`);
    expect(prepared?.postText).toContain("6 more startup attachments");
    const block = await prepared!.record();
    expect(block.attachments).toHaveLength(BLOCK_ATTACHMENTS_MAX);
  });

  it("fills in a card that is already there instead of refusing the id", async () => {
    // The startup wrote the card first: the briefing lands on it and keeps
    // what the startup wrote.
    await service.recordSystemPrompt({ agentId: A, prompt: "Be useful." });
    const first = await service.prepareLaunchContext({
      agentId: A,
      text: "First",
    });
    expect(first!.id).toBe(launchBlockId(A));
    await first!.record();
    const second = await service.prepareLaunchContext({
      agentId: A,
      text: "Second",
      launchedByAgentId: B,
    });
    const written = await second!.record();
    expect(written).toMatchObject({
      id: launchBlockId(A),
      text: "Second",
      launchedByAgentId: B,
      state: { instructions: "Be useful." },
    });
    const rows = await pool.query<{ text: string }>(
      "SELECT text FROM blocks WHERE stream_id = $1",
      [A]
    );
    expect(rows.rows).toEqual([{ text: "Second" }]);
  });

  it("writes onto an older card found by agent, whatever its id", async () => {
    const legacy = await service.store.insert({
      id: "7c1f0a10-2222-4333-8444-555566667777",
      streamId: A,
      author: { kind: "user" },
      toAgentId: A,
      kind: "launch",
      text: "",
      state: {},
      delivered: true,
    });
    const prepared = await service.prepareLaunchContext({
      agentId: A,
      text: "Build it",
    });
    expect(prepared!.id).toBe(legacy.id);
    expect((await prepared!.record()).text).toBe("Build it");
    // Startup and instructions find the same card.
    await service.recordSystemPrompt({ agentId: A, prompt: "Be useful." });
    const rows = await pool.query<{ id: string }>(
      "SELECT id FROM blocks WHERE stream_id = $1",
      [A]
    );
    expect(rows.rows).toEqual([{ id: legacy.id }]);
  });
});

// ---------------------------------------------------------------------------
// Kind inference and validation
// ---------------------------------------------------------------------------

describe("resolveKindAndData", () => {
  it("infers the kind from the payload given, defaulting to text", () => {
    expect(resolveKindAndData({ text: "hi" })).toEqual({
      kind: "text",
      data: null,
    });
    expect(resolveKindAndData({})).toEqual({ kind: "text", data: null });
    expect(
      resolveKindAndData({ question: { options: [{ label: "a" }] } })
    ).toEqual({ kind: "question", data: { options: [{ label: "a" }] } });
    expect(
      resolveKindAndData({
        form: { fields: [{ id: "n", label: "N", type: "text" }] },
      }).kind
    ).toBe("form");
    expect(resolveKindAndData({ link: { url: "https://x.y" } })).toEqual({
      kind: "link",
      data: { url: "https://x.y" },
    });
    expect(
      resolveKindAndData({
        review: { summary: "ok", findings: [] },
      }).kind
    ).toBe("review");
    // Findings and launch cards are written by Dispatch, never posted.
    expect(() => resolveKindAndData({ kind: "finding" })).toThrow(
      /A finding block is written by Dispatch/
    );
    expect(() => resolveKindAndData({ kind: "launch" })).toThrow(
      /A launch block is written by Dispatch/
    );
    expect(
      resolveKindAndData({ tasks: { items: [{ id: "t", text: "x" }] } }).kind
    ).toBe("tasks");
    expect(
      resolveKindAndData({
        kind: "file",
        attachments: [{ type: "file", fileName: "a.png" }],
      })
    ).toEqual({ kind: "file", data: null });
  });

  it("refuses two payloads, or a kind that disagrees with the payload", () => {
    expect(() =>
      resolveKindAndData({
        question: { options: [{ label: "a" }] },
        link: { url: "https://x.y" },
      })
    ).toThrow(
      /one of question, form, link, review or tasks, not question and link/
    );
    expect(() =>
      resolveKindAndData({
        kind: "text",
        question: { options: [{ label: "a" }] },
      })
    ).toThrow(/kind "text" does not match the question data/);
    expect(() => resolveKindAndData({ kind: "question", text: "?" })).toThrow(
      /question needs at least one option/
    );
    expect(() => resolveKindAndData({ kind: "file", text: "x" })).toThrow(
      /needs at least one file attachment/
    );
    expect(() =>
      resolveKindAndData({
        kind: "file",
        attachments: [{ type: "link", url: "https://x" }],
      })
    ).toThrow(/file attachment/);
  });

  it("validates and normalizes a question", () => {
    expect(
      resolveKindAndData({
        question: {
          options: [{ label: "a", value: "A" }, { label: "b" }],
          allowFreeform: true,
        },
      }).data
    ).toEqual({
      options: [{ label: "a", value: "A" }, { label: "b" }],
      allowFreeform: true,
    });
    // allowFreeform false is dropped; unknown keys on options are dropped.
    expect(
      resolveKindAndData({
        question: {
          options: [{ label: "a", extra: 1 } as never],
          allowFreeform: false,
        },
      }).data
    ).toEqual({ options: [{ label: "a" }] });
    expect(() => resolveKindAndData({ question: { options: [] } })).toThrow(
      /at least one option/
    );
    expect(() =>
      resolveKindAndData({
        question: {
          options: Array.from({ length: 11 }, (_, i) => ({ label: `o${i}` })),
        },
      })
    ).toThrow(/10 entries or fewer/);
  });

  it("validates a form: fields, unique ids, select options", () => {
    expect(() => resolveKindAndData({ form: { fields: [] } })).toThrow(
      /at least one field/
    );
    expect(() =>
      resolveKindAndData({
        form: {
          fields: [
            { id: "a", label: "A", type: "text" },
            { id: "a", label: "B", type: "text" },
          ],
        },
      })
    ).toThrow(/Duplicate form field id "a"/);
    expect(() =>
      resolveKindAndData({
        form: { fields: [{ id: " ", label: "A", type: "text" }] },
      })
    ).toThrow(/needs an id/);
    expect(() =>
      resolveKindAndData({
        form: { fields: [{ id: "s", label: "S", type: "select" }] },
      })
    ).toThrow(/"s" is a select and needs options/);
    expect(() =>
      resolveKindAndData({
        form: {
          fields: Array.from({ length: 21 }, (_, i) => ({
            id: `f${i}`,
            label: "F",
            type: "text" as const,
          })),
        },
      })
    ).toThrow(/20 entries or fewer/);
  });

  it("validates a link's url", () => {
    expect(
      resolveKindAndData({ link: { url: " https://x.y/p ", title: "T" } }).data
    ).toEqual({ url: "https://x.y/p", title: "T" });
    for (const url of ["javascript:alert(1)", "not a url", "ftp://x", ""]) {
      expect(() => resolveKindAndData({ link: { url } })).toThrow(
        /absolute http\(s\) url/
      );
    }
  });

  it("validates a review: summary, findings, severities, titles, bodies", () => {
    const finding = { severity: "major", title: "t", body: "b" } as const;
    expect(
      resolveKindAndData({
        review: {
          summary: "s",
          findings: [
            finding,
            {
              severity: "nit",
              title: "  padded  ",
              body: "x",
              path: " a.ts ",
              line: 3,
            },
          ],
        },
      }).data
    ).toEqual({
      summary: "s",
      findings: [
        finding,
        { severity: "nit", title: "padded", body: "x", path: "a.ts", line: 3 },
      ],
    });
    // What an author may not set is dropped: an id (the finding block has
    // its own), a verdict, a line that is not a positive integer.
    expect(
      resolveKindAndData({
        review: {
          verdict: "approve",
          summary: "s",
          findings: [{ ...finding, id: "f1", line: 0, path: "  " }],
        } as never,
      }).data
    ).toEqual({ summary: "s", findings: [finding] });
    expect(() =>
      resolveKindAndData({ review: { summary: "s" } as never })
    ).toThrow(/review needs summary and findings/);
    expect(() =>
      resolveKindAndData({ review: { findings: [] } as never })
    ).toThrow(/review needs summary and findings/);
    expect(() =>
      resolveKindAndData({
        review: {
          summary: "s",
          findings: [finding, { ...finding, severity: "huge" as never }],
        },
      })
    ).toThrow(/finding 2 has an unknown severity/);
    expect(() =>
      resolveKindAndData({
        review: { summary: "s", findings: [{ ...finding, title: "  " }] },
      })
    ).toThrow(/finding 1 needs a title/);
    expect(() =>
      resolveKindAndData({
        review: { summary: "s", findings: [{ ...finding, body: "" }] },
      })
    ).toThrow(/finding 1 needs a body/);
    // Two findings alike are two findings: nothing keys them but their blocks.
    expect(
      (
        resolveKindAndData({
          review: { summary: "s", findings: [finding, finding] },
        }).data as { findings: unknown[] }
      ).findings
    ).toHaveLength(2);
    expect(() =>
      resolveKindAndData({
        review: {
          summary: "s",
          findings: Array.from({ length: 51 }, () => finding),
        },
      })
    ).toThrow(/50 entries or fewer/);
  });

  it("validates tasks: items, unique ids, cap", () => {
    expect(() => resolveKindAndData({ tasks: { items: [] } })).toThrow(
      /at least one item/
    );
    expect(() =>
      resolveKindAndData({
        tasks: {
          items: [
            { id: "t", text: "a" },
            { id: "t", text: "b" },
          ],
        },
      })
    ).toThrow(/Duplicate task id "t"/);
    expect(() =>
      resolveKindAndData({
        tasks: {
          items: Array.from({ length: 51 }, (_, i) => ({
            id: `t${i}`,
            text: "x",
          })),
        },
      })
    ).toThrow(/50 entries or fewer/);
  });
});

// ---------------------------------------------------------------------------
// Agent post / update
// ---------------------------------------------------------------------------

describe("StreamService.post", () => {
  it("persists an agent block on its own stream and publishes it as a feed entry", async () => {
    const block = await service.post(A, { text: "hello" });
    expect(block).toMatchObject({
      streamId: A,
      author: { kind: "agent", agentId: A },
      toAgentId: null,
      kind: "text",
      text: "hello",
      data: null,
      state: null,
      delivered: null,
      threadId: null,
      replyTo: null,
    });
    expect(published).toEqual([entryEvent(block)]);
  });

  it("validates at the service boundary", async () => {
    await expect(service.post(A, { text: "  " })).rejects.toThrow(
      /A post needs text, an attachment, or one of/
    );
    await expect(service.post(A, {})).rejects.toBeInstanceOf(
      StreamValidationError
    );
    await expect(service.post(A, { text: "x".repeat(20_001) })).rejects.toThrow(
      /20000 characters or fewer/
    );
    await expect(
      service.post(A, {
        text: "x",
        attachments: Array.from({ length: 21 }, () => ({
          type: "link" as const,
          url: "https://example.com",
        })),
      })
    ).rejects.toThrow(/20 entries or fewer/);
    await expect(
      service.post(A, { kind: "text", question: { options: [{ label: "a" }] } })
    ).rejects.toThrow(/does not match/);
    await expect(service.post("agt_nobody", { text: "x" })).rejects.toThrow(
      /Agent agt_nobody not found/
    );
    await expect(service.post(A, { text: "x", to: A })).rejects.toThrow(
      /to must name another agent/
    );
    await expect(
      service.post(A, { text: "x", to: "agt_nobody" })
    ).rejects.toThrow(/Agent agt_nobody not found/);
    expect(published).toEqual([]);
  });

  it("infers the kind and seeds the initial state per kind", async () => {
    const question = await service.post(A, {
      text: "Ship?",
      question: { options: [{ label: "Yes", value: "y" }] },
    });
    expect(question).toMatchObject({
      kind: "question",
      data: { options: [{ label: "Yes", value: "y" }] },
      state: {},
    });
    const form = await service.post(A, {
      form: { fields: [{ id: "n", label: "Name", type: "text" }] },
    });
    expect(form).toMatchObject({ kind: "form", state: {}, text: "" });
    const link = await service.post(A, { link: { url: "https://x.y" } });
    expect(link).toMatchObject({
      kind: "link",
      data: { url: "https://x.y" },
      state: null,
    });
    const review = await service.post(A, {
      review: {
        summary: "s",
        findings: [
          { severity: "major", title: "a", body: "b" },
          { severity: "nit", title: "c", body: "d" },
        ],
      },
    });
    expect(review.kind).toBe("review");
    // The review's data is its summary; its findings are blocks it shows,
    // each open, stamped by the reviewer.
    expect(review.data).toEqual({ summary: "s" });
    const findings = review.blocks ?? [];
    expect(review.state).toEqual({ blocks: findings.map((f) => f.id) });
    expect(findings).toMatchObject([
      {
        kind: "finding",
        data: { severity: "major", title: "a", body: "b" },
        state: {
          status: "open",
          by: { kind: "agent", agentId: A },
          at: expect.any(String),
        },
        threadId: review.id,
        replyTo: review.id,
      },
      { kind: "finding", data: { title: "c" }, threadId: review.id },
    ]);
    const tasks = await service.post(A, {
      tasks: {
        items: [
          { id: "t1", text: "a" },
          { id: "t2", text: "b" },
        ],
      },
    });
    expect(tasks.state).toEqual({ items: { t1: "todo", t2: "todo" } });
  });

  it("resolves file attachments by stored fileName or fileId", async () => {
    await pool.query(
      `INSERT INTO files (agent_id, file_name, source, size_bytes, mime_type)
       VALUES ($1, 'shot-2026-01-01-00-00-00-000.png', 'screenshot', 123, 'image/png'),
              ($1, 'report.pdf', 'screenshot', 456, 'application/pdf'),
              ($2, 'theirs.png', 'screenshot', 1, 'image/png')`,
      [A, B]
    );
    const pdf = await pool.query<{ id: number }>(
      `SELECT id FROM files WHERE file_name = 'report.pdf'`
    );
    const block = await service.post(A, {
      text: "see",
      attachments: [
        { type: "file", fileName: "shot-2026-01-01-00-00-00-000.png" },
        { type: "file", fileId: pdf.rows[0].id },
        { type: "link", url: "https://example.com" },
        { type: "pr", url: "https://gh/1", title: "PR" },
        { type: "code", code: "x = 1", language: "py" },
      ],
    });
    expect(block.attachments).toEqual([
      {
        type: "file",
        fileId: expect.any(Number),
        fileName: "shot-2026-01-01-00-00-00-000.png",
        sizeBytes: 123,
        mimeType: "image/png",
        media: "image",
        ownerAgentId: A,
      },
      {
        type: "file",
        fileId: pdf.rows[0].id,
        fileName: "report.pdf",
        sizeBytes: 456,
        mimeType: "application/pdf",
        media: "pdf",
        ownerAgentId: A,
      },
      { type: "link", url: "https://example.com" },
      { type: "pr", url: "https://gh/1", title: "PR" },
      { type: "code", code: "x = 1", language: "py" },
    ]);
    expect(block.attachments[0]).not.toHaveProperty("path");

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
    ).rejects.toThrow(/fileName, fileId or path/);
    // Two identifiers: refused, never a guess — even when they agree.
    await expect(
      service.post(A, {
        text: "see",
        attachments: [
          { type: "file", fileName: "report.pdf", fileId: pdf.rows[0].id },
        ],
      })
    ).rejects.toThrow(/not both/);
    await expect(
      service.post(A, {
        text: "see",
        attachments: [{ type: "link", url: "javascript:1" }],
      })
    ).rejects.toThrow(/http or https/);
  });

  it("uploads a file given by path through the uploadFile dep, then attaches it", async () => {
    const uploadFile = vi.fn(
      async (
        agentId: string,
        input: { filePath: string; description: string }
      ) => {
        await pool.query(
          `INSERT INTO files (agent_id, file_name, source, size_bytes, description, mime_type)
         VALUES ($1, 'shot-uploaded.png', 'screenshot', 77, $2, 'image/png')`,
          [agentId, input.description]
        );
        return { fileName: "shot-uploaded.png" };
      }
    );
    const { svc, events } = build({
      withDelivery: false,
      deps: { uploadFile },
    });
    const block = await svc.post(A, {
      kind: "file",
      attachments: [{ type: "file", path: "/tmp/shots/shot.png" }],
    });
    expect(uploadFile).toHaveBeenCalledWith(A, {
      filePath: "/tmp/shots/shot.png",
      description: "shot.png",
    });
    expect(block).toMatchObject({
      kind: "file",
      text: "",
      attachments: [
        {
          type: "file",
          fileName: "shot-uploaded.png",
          sizeBytes: 77,
          mimeType: "image/png",
          media: "image",
        },
      ],
    });
    expect(events).toEqual([entryEvent(block)]);

    // A description travels with the upload.
    await svc.post(A, {
      text: "again",
      attachments: [
        { type: "file", path: "/tmp/b.png", description: "the board" },
      ],
    });
    expect(uploadFile).toHaveBeenLastCalledWith(A, {
      filePath: "/tmp/b.png",
      description: "the board",
    });

    // Without the dep a path is refused before anything is written.
    await expect(
      service.post(A, {
        text: "x",
        attachments: [{ type: "file", path: "/tmp/a.png" }],
      })
    ).rejects.toThrow(/File uploads are not available/);
    // A failed upload surfaces and writes no block.
    uploadFile.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      svc.post(A, {
        text: "x",
        attachments: [{ type: "file", path: "/tmp/c.png" }],
      })
    ).rejects.toThrow(/disk full/);
    const rows = await pool.query("SELECT count(*)::int AS n FROM blocks");
    expect(rows.rows[0].n).toBe(2);
  });

  it("stores no dimensions on a file attachment, even for a measured image", async () => {
    await pool.query(
      `INSERT INTO files (agent_id, file_name, source, size_bytes, metadata, mime_type)
       VALUES ($1, 'measured.png', 'screenshot', 9, '{"width":120,"height":90}'::jsonb, 'image/png')`,
      [A]
    );
    const block = await service.post(A, {
      text: "see",
      attachments: [{ type: "file", fileName: "measured.png" }],
    });
    expect(block.attachments[0]).not.toHaveProperty("width");
    expect(block.attachments[0]).not.toHaveProperty("height");
  });

  it("threads a reply under a top-level block, resolving a reply's root", async () => {
    const root = await service.post(A, { text: "root" });
    published.length = 0;
    const reply = await service.post(A, { text: "reply", replyTo: root.id });
    expect(reply).toMatchObject({ threadId: root.id, replyTo: root.id });
    // A reply publishes itself (the client files it into the open thread),
    // then its root with the changed reply count.
    expect(published).toEqual([
      expect.objectContaining({
        type: "stream.entry",
        entry: expect.objectContaining({
          id: reply.id,
          block: expect.objectContaining({ threadId: root.id }),
        }),
      }),
      expect.objectContaining({
        type: "stream.entry",
        entry: expect.objectContaining({
          id: root.id,
          block: expect.objectContaining({ replyCount: 1 }),
        }),
      }),
    ]);
    const nested = await service.post(A, { text: "nested", replyTo: reply.id });
    expect(nested).toMatchObject({ threadId: root.id, replyTo: reply.id });
    expect(
      (await service.store.listThread(root.id))?.replies.map((r) => r.id)
    ).toEqual([reply.id, nested.id]);
  });

  it("rejects a replyTo that is malformed, unknown, or on another stream", async () => {
    await expect(
      service.post(A, { text: "x", replyTo: "not-a-uuid" })
    ).rejects.toThrow(/replyTo must be a block id/);
    expect(published).toEqual([]);
    await expect(service.post(A, { text: "x", replyTo: NIL })).rejects.toThrow(
      /replyTo must name a block on this stream/
    );
    const theirs = await service.store.insert({
      streamId: B,
      author: { kind: "user" },
      toAgentId: B,
      text: "not yours",
    });
    await expect(
      service.post(A, { text: "x", replyTo: theirs.id })
    ).rejects.toThrow(/on this stream/);
    const rows = await pool.query(
      "SELECT id FROM blocks WHERE stream_id = $1",
      [A]
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("marks the agent waiting when it posts a question or form for people", async () => {
    const onInputPosted = vi.fn(async () => {});
    const { svc } = build({ access: inert, deps: { onInputPosted } });
    await svc.post(A, {
      text: "Ship it?",
      question: { options: [{ label: "Yes" }] },
    });
    expect(onInputPosted).toHaveBeenLastCalledWith(A, "Ship it?");
    await svc.post(A, {
      question: { options: [{ label: "Yes" }, { label: "No" }] },
    });
    expect(onInputPosted).toHaveBeenLastCalledWith(A, "Yes / No");
    await svc.post(A, {
      form: {
        title: "Deploy details",
        fields: [{ id: "n", label: "N", type: "text" }],
      },
    });
    expect(onInputPosted).toHaveBeenLastCalledWith(A, "Deploy details");
    await svc.post(A, {
      form: { fields: [{ id: "n", label: "N", type: "text" }] },
    });
    expect(onInputPosted).toHaveBeenLastCalledWith(A, "Form");
    onInputPosted.mockClear();
    // Not for plain text, and not for a question addressed to an agent.
    await svc.post(A, { text: "fyi" });
    await svc.post(A, { to: B, question: { options: [{ label: "a" }] } });
    expect(onInputPosted).not.toHaveBeenCalled();
    // A failing hook does not fail the post.
    onInputPosted.mockRejectedValueOnce(new Error("db down"));
    await expect(
      svc.post(A, { question: { options: [{ label: "a" }] } })
    ).resolves.toMatchObject({ kind: "question" });
  });

  it("sends the notification only when asked, and survives its failure", async () => {
    const notify = vi.fn(async () => ({ sent: true }));
    const { svc } = build({ withDelivery: false, deps: { notify } });
    await svc.post(A, { text: "Done." });
    expect(notify).not.toHaveBeenCalled();
    await svc.post(A, { text: "Build finished", notify: true });
    expect(notify).toHaveBeenCalledWith(A, { message: "Build finished" });
    await svc.post(A, {
      notify: true,
      question: { options: [{ label: "Yes" }] },
    });
    expect(notify).toHaveBeenLastCalledWith(A, { message: "Yes" });
    notify.mockRejectedValueOnce(new Error("slack down"));
    await expect(
      svc.post(A, { text: "x", notify: true })
    ).resolves.toMatchObject({
      text: "x",
    });
    // Without the dep, notify is silently ignored.
    await expect(
      service.post(A, { text: "x", notify: true })
    ).resolves.toBeTruthy();
  });

  it("delivers a post with `to` as a DISPATCH POST from the agent, settling delivered", async () => {
    await seedFiles(A, "diff.patch", 2048);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { svc, events, injected } = build({ gate, held: true });
    const block = await svc.post(A, {
      to: B,
      text: "Please review this.",
      attachments: [
        { type: "file", fileName: "diff.patch" },
        { type: "link", url: "https://gh/pr/1", title: "PR" },
      ],
    });
    expect(block).toMatchObject({
      streamId: A,
      author: { kind: "agent", agentId: A },
      toAgentId: B,
      delivered: null,
    });
    expect(injected).toHaveLength(0);
    expect(events).toEqual([entryEvent(block)]);
    expect(svc.inFlightDeliveryCount).toBe(1);

    release();
    const row = await settled(svc, block.id);
    expect(row.delivered).toBe(true);
    expect(injected).toHaveLength(1);
    expect(injected[0]?.agentId).toBe(B);
    expect(injected[0]?.text.split("\n")).toEqual([
      `--- DISPATCH POST (id: ${block.id}, from: Svc (${A})) ---`,
      "Please review this.",
      "",
      "Attachments:",
      expect.stringMatching(/^- file: .*diff\.patch \([\w/-]+, 2 KB\)$/),
      "- link: https://gh/pr/1 — PR",
      "--- END DISPATCH POST ---",
      `From another agent. Reply with post (to: "${A}") only if a reply is needed; routine updates need no acknowledgement.`,
    ]);
    // Pending first, then the same row once delivery settled it.
    expect(
      events.map(
        (e) => (e as { entry: { block: Block } }).entry.block.delivered
      )
    ).toEqual([null, true]);
    expect(svc.inFlightDeliveryCount).toBe(0);
  });

  it("records delivered=false for a `to` when the engine is inert or the inject fails", async () => {
    const inertSvc = build({ access: inert });
    const undelivered = await inertSvc.svc.post(A, { to: B, text: "hi" });
    expect(undelivered.delivered).toBe(false);
    expect(inertSvc.injected).toEqual([]);
    const failing = build({ fail: true });
    const failed = await failing.svc.post(A, { to: B, text: "hi" });
    expect(failed.delivered).toBeNull();
    expect((await settled(failing.svc, failed.id)).delivered).toBe(false);
  });

  it("threads a follow-up to another agent and says so in the envelope", async () => {
    const { svc, injected } = build();
    const root = await svc.post(A, { to: B, text: "Two findings." });
    await settled(svc, root.id);
    injected.length = 0;
    const reply = await svc.post(A, {
      to: B,
      text: "One more.",
      replyTo: root.id,
    });
    expect(reply).toMatchObject({
      threadId: root.id,
      replyTo: root.id,
      toAgentId: B,
    });
    await settled(svc, reply.id);
    expect(injected[0]?.text).toContain(`In the thread under ${root.id}.`);
    expect(injected[0]?.text).toContain(
      `Reply with post (to: "${A}", replyTo: "${root.id}")`
    );
  });
});

describe("StreamService.update", () => {
  it("edits the agent's own block and publishes it", async () => {
    const mine = await service.post(A, { text: "draft" });
    published.length = 0;
    const updated = await service.update(A, mine.id, { text: "final" });
    expect(updated).toMatchObject({ id: mine.id, text: "final" });
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(mine.updatedAt)
    );
    expect(published).toEqual([entryEvent(updated)]);
  });

  it("refuses other people's blocks, malformed ids, and unknown blocks", async () => {
    const mine = await service.post(A, { text: "draft" });
    await expect(
      service.update(B, mine.id, { text: "hijack" })
    ).rejects.toBeInstanceOf(StreamForbiddenError);
    await expect(
      service.update(A, "not-a-uuid", { text: "x" })
    ).rejects.toThrow(/id must be the id returned by post/);
    await expect(service.update(A, NIL, { text: "x" })).rejects.toBeInstanceOf(
      StreamNotFoundError
    );
    const userRow = await service.store.insert({
      streamId: A,
      author: { kind: "user" },
      toAgentId: A,
      text: "from user",
    });
    // A user block addressed to the agent: only its state, and text has none.
    await expect(
      service.update(A, userRow.id, { text: "nope" })
    ).rejects.toThrow(/Only the state of a block addressed to you/);
    await expect(service.update(A, userRow.id, {})).rejects.toThrow(
      /state is required/
    );
    await expect(
      service.update(A, userRow.id, { state: { items: { a: "done" } } })
    ).rejects.toThrow(/A text block has no state/);
    expect((await service.store.getById(mine.id))?.text).toBe("draft");
  });

  it("replaces data through the kind's own validation", async () => {
    const q = await service.post(A, {
      text: "Ship?",
      question: { options: [{ label: "a" }] },
    });
    const updated = await service.update(A, q.id, {
      data: { options: [{ label: "b", value: "B" }], allowFreeform: true },
    });
    expect(updated).toMatchObject({
      kind: "question",
      data: { options: [{ label: "b", value: "B" }], allowFreeform: true },
    });
    await expect(
      service.update(A, q.id, { data: { options: [] } })
    ).rejects.toThrow(/at least one option/);
    const link = await service.post(A, { link: { url: "https://a.b" } });
    await expect(
      service.update(A, link.id, { data: { url: "javascript:1" } })
    ).rejects.toThrow(/http\(s\) url/);
    const tasks = await service.post(A, {
      tasks: { items: [{ id: "t1", text: "a" }] },
    });
    expect(
      (
        await service.update(A, tasks.id, {
          data: { items: [{ id: "t2", text: "b" }] },
        })
      ).data
    ).toEqual({ items: [{ id: "t2", text: "b" }] });
  });

  it("replaces attachments wholesale, uploading paths", async () => {
    const uploadFile = vi.fn(async (agentId: string) => {
      await pool.query(
        `INSERT INTO files (agent_id, file_name, source, size_bytes, mime_type)
         VALUES ($1, 'late.png', 'screenshot', 5, 'image/png')`,
        [agentId]
      );
      return { fileName: "late.png" };
    });
    const { svc } = build({ withDelivery: false, deps: { uploadFile } });
    const m = await svc.post(A, {
      text: "x",
      attachments: [{ type: "link", url: "https://a.com" }],
    });
    const updated = await svc.update(A, m.id, {
      attachments: [
        { type: "code", code: "let x = 1", language: "ts" },
        { type: "file", path: "/tmp/late.png" },
      ],
    });
    expect(updated.attachments).toEqual([
      { type: "code", code: "let x = 1", language: "ts" },
      expect.objectContaining({ type: "file", fileName: "late.png" }),
    ]);
    expect(
      (await svc.update(A, m.id, { attachments: [] })).attachments
    ).toEqual([]);
  });

  it("sets state on the agent's own findings and tasks, stamped by the agent", async () => {
    const review = await service.post(A, {
      review: {
        summary: "s",
        findings: [
          { severity: "major", title: "a", body: "b" },
          { severity: "nit", title: "c", body: "d" },
        ],
      },
    });
    const [f1, f2] = review.blocks!;
    const resolved = await service.update(A, f1!.id, {
      state: { status: "resolved", note: "  done  " },
    });
    // A finding's record is replaced, not merged, and the other is untouched.
    expect(resolved.state).toEqual({
      status: "resolved",
      resolution: "fixed",
      note: "done",
      by: { kind: "agent", agentId: A },
      at: expect.any(String),
    });
    const dismissed = await service.update(A, f2!.id, {
      state: { status: "dismissed" },
    });
    expect(dismissed.state).toEqual({
      status: "resolved",
      resolution: "dismissed",
      by: { kind: "agent", agentId: A },
      at: expect.any(String),
    });
    const reopened = await service.update(A, f1!.id, {
      state: { status: "open" },
    });
    expect(reopened.state).toEqual({
      status: "open",
      by: { kind: "agent", agentId: A },
      at: expect.any(String),
    });
    const tasks = await service.post(A, {
      tasks: {
        items: [
          { id: "t1", text: "a" },
          { id: "t2", text: "b" },
        ],
      },
    });
    const ticked = await service.update(A, tasks.id, {
      text: "Progress",
      state: { items: { t1: "done", t2: "now" } },
    });
    expect(ticked).toMatchObject({
      text: "Progress",
      state: { items: { t1: "done", t2: "now" } },
    });
    await expect(
      service.update(A, tasks.id, { state: { items: { t1: "later" } } })
    ).rejects.toThrow(/must be todo, now or done/);
    await expect(
      service.update(A, f1!.id, { state: { status: "wontfix" } })
    ).rejects.toThrow(
      /A finding's state is \{ status: "open" \| "fixed" \| "dismissed", note\? \}/
    );
    await expect(
      service.update(A, f1!.id, { state: { items: {} } })
    ).rejects.toThrow(/A finding's state is/);
    await expect(
      service.update(A, tasks.id, { state: { status: "fixed" } })
    ).rejects.toThrow(/state\.items is required/);
    // A review's state is the findings it shows: it cannot be set.
    await expect(
      service.update(A, review.id, { state: { blocks: [] } })
    ).rejects.toThrow(/A review's state is its findings/);
    expect((await service.store.getById(review.id))!.state).toEqual({
      blocks: [f1!.id, f2!.id],
    });
  });

  it("edits a review's summary and a finding's words through their own validation", async () => {
    const review = await service.post(A, {
      review: {
        summary: "s",
        findings: [{ severity: "major", title: "a", body: "b" }],
      },
    });
    const finding = review.blocks![0]!;
    const summary = await service.update(A, review.id, {
      data: { summary: "Better" },
    });
    expect(summary.data).toEqual({ summary: "Better" });
    await expect(
      service.update(A, review.id, {
        data: { summary: "s", findings: [] } as never,
      })
    ).resolves.toMatchObject({ data: { summary: "s" } });
    await expect(
      service.update(A, review.id, { data: { verdict: "approve" } as never })
    ).rejects.toThrow(/A review's data is \{ summary \}/);
    const edited = await service.update(A, finding.id, {
      data: { severity: "minor", title: "a2", body: "b2", path: "x.ts" },
    });
    expect(edited.data).toEqual({
      severity: "minor",
      title: "a2",
      body: "b2",
      path: "x.ts",
    });
    await expect(
      service.update(A, finding.id, { data: { severity: "huge" } as never })
    ).rejects.toThrow(/unknown severity/);
  });

  it("merges raw state onto a question or form the agent owns", async () => {
    const q = await service.post(A, {
      question: { options: [{ label: "a" }] },
    });
    const updated = await service.update(A, q.id, { state: { note: "hint" } });
    expect(updated.state).toEqual({ note: "hint" });
  });

  it("lets the author close its own question with what settled it", async () => {
    const q = await service.post(A, {
      text: "Discard the stray edit?",
      question: { options: [{ label: "Discard it" }, { label: "Keep it" }] },
    });
    await expect(
      service.update(A, q.id, { state: { answer: "  " } })
    ).rejects.toThrow(/state\.answer must be the answer as text/);
    const closed = await service.update(A, q.id, {
      state: { answer: "Discard it" },
    });
    expect(closed.state).toEqual({
      answer: {
        value: "Discard it",
        label: "Discard it",
        by: { kind: "agent", agentId: A },
        at: expect.any(String),
      },
    });
    await expect(
      service.update(A, q.id, { state: { answer: "Keep it" } })
    ).rejects.toBeInstanceOf(StreamConflictError);
    // Freeform closes with the words given; the Inbox no longer lists it.
    const q2 = await service.post(A, {
      question: { options: [{ label: "Yes" }] },
    });
    const done = await service.update(A, q2.id, {
      state: { answer: { value: "Resolved on my own" } },
    });
    expect(done.state).toMatchObject({
      answer: {
        value: "Resolved on my own",
        by: { kind: "agent", agentId: A },
      },
    });
    expect(await service.store.countUnread(A)).toBeGreaterThanOrEqual(0);
  });

  it("lets the recipient change only the state of a block addressed to it", async () => {
    const { svc, injected } = build();
    const review = await svc.post(B, {
      to: A,
      review: {
        summary: "s",
        findings: [{ severity: "major", title: "a", body: "b" }],
      },
    });
    await settled(svc, review.id);
    const finding = review.blocks![0]!;
    // The finding is addressed to the agent the review is.
    expect(finding).toMatchObject({ toAgentId: A, delivered: true });
    injected.length = 0;
    await expect(
      svc.update(A, finding.id, { text: "mine now" })
    ).rejects.toBeInstanceOf(StreamForbiddenError);
    await expect(
      svc.update(A, finding.id, { data: {} })
    ).rejects.toBeInstanceOf(StreamForbiddenError);
    await expect(
      svc.update(A, finding.id, { attachments: [] })
    ).rejects.toBeInstanceOf(StreamForbiddenError);
    await expect(svc.update(A, finding.id, {})).rejects.toThrow(
      /state is required/
    );
    // The review itself: its state is not the recipient's to change.
    await expect(
      svc.update(A, review.id, { state: { status: "fixed" } })
    ).rejects.toThrow(/A review block has no state/);
    const resolved = await svc.update(A, finding.id, {
      state: { status: "fixed" },
    });
    expect(resolved.state).toEqual({
      status: "resolved",
      resolution: "fixed",
      by: { kind: "agent", agentId: A },
      at: expect.any(String),
    });
    // The reviewer hears about it, on the finding, with whose move it is.
    await svc.waitForInFlightDeliveries(1_000);
    expect(injected).toEqual([
      {
        agentId: B,
        text: expect.stringContaining(
          `--- DISPATCH POST (id: ${finding.id}, from: Svc (${A})) ---\nFinding "a" fixed.\nNothing to do unless you disagree`
        ),
      },
    ]);
    expect(injected[0]!.text).toContain(`replyTo: "${finding.id}"`);
    // A third agent may not.
    await expect(
      svc.update("agt_third", finding.id, { state: { status: "open" } })
    ).rejects.toBeInstanceOf(StreamForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// People: posts, answers, forms, state
// ---------------------------------------------------------------------------

describe("StreamService.sendUserPost", () => {
  it("sends an advertised slash command as its own raw ACP turn", async () => {
    const { svc, injected, injectedOpts } = build({
      commands: ["skills", "review"],
    });
    const result = await svc.sendUserPost(A, { text: "/skills list" });
    await settled(svc, result.block.id);
    expect(result.block.text).toBe("/skills list");
    expect(injected).toEqual([{ agentId: A, text: "/skills list" }]);
    expect(injectedOpts[0]).toMatchObject({
      blockId: result.block.id,
      alone: true,
    });

    const unknown = await svc.sendUserPost(A, { text: "/unknown list" });
    await settled(svc, unknown.block.id);
    expect(injected[1]?.text).toContain("--- DISPATCH POST");
  });

  it("persists pending, returns held, then settles delivered", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { svc, events, injected } = build({ held: true, gate });
    const res = await svc.sendUserPost(A, { text: "do the thing" });
    expect(res).toMatchObject({
      delivered: null,
      held: true,
      block: {
        author: { kind: "user" },
        toAgentId: A,
        kind: "text",
        delivered: null,
        threadId: null,
      },
    });
    expect(injected).toHaveLength(0);
    expect(events).toEqual([entryEvent(res.block)]);
    expect(svc.inFlightDeliveryCount).toBe(1);

    release();
    const row = await settled(svc, res.block.id);
    expect(row.delivered).toBe(true);
    expect(injected[0]).toEqual({
      agentId: A,
      text: [
        `--- DISPATCH POST (id: ${res.block.id}, from: user) ---`,
        "do the thing",
        "--- END DISPATCH POST ---",
        "Your reply appears in the stream as you write it. Use post only for a question with options, a file, a link, or to reach another agent.",
      ].join("\n"),
    });
    expect(events).toHaveLength(2);
    expect(await svc.waitForInFlightDeliveries(1_000)).toBe(true);
    expect(svc.inFlightDeliveryCount).toBe(0);
  });

  it("marks a file attachment with the agent it was sent to, whose file it is", async () => {
    await pool.query(
      `INSERT INTO agents (id, name, cwd, status, parent_agent_id)
       VALUES ('agt_own_kid', 'kid', '/tmp', 'running', $1)
       ON CONFLICT (id) DO UPDATE SET parent_agent_id = EXCLUDED.parent_agent_id, deleted_at = NULL`,
      [A]
    );
    AGENTS["agt_own_kid"] = {
      id: "agt_own_kid",
      name: "kid",
      filesDir: null,
      status: "running",
    };
    const fileId = await seedFiles("agt_own_kid", "kid-brief.png", 64);
    const { svc } = build({});
    const res = await svc.sendUserPost(A, {
      to: "agt_own_kid",
      text: "look",
      attachments: [{ type: "file", fileId }],
    });
    expect(res.block).toMatchObject({
      streamId: A,
      author: { kind: "user" },
      toAgentId: "agt_own_kid",
    });
    expect(res.block.attachments).toEqual([
      {
        type: "file",
        fileId,
        fileName: "kid-brief.png",
        sizeBytes: 64,
        mimeType: "image/png",
        media: "image",
        ownerAgentId: "agt_own_kid",
      },
    ]);
    expect((await svc.store.getById(res.block.id))!.attachments).toEqual(
      res.block.attachments
    );
  });

  it("records delivered=false when the inject fails", async () => {
    const { svc } = build({ fail: true });
    const res = await svc.sendUserPost(A, { text: "hello" });
    expect((await settled(svc, res.block.id)).delivered).toBe(false);
  });

  it("rejects invalid text, and either records or refuses an inert post", async () => {
    const { svc } = build({ access: inert });
    await expect(svc.sendUserPost(A, { text: "   " })).rejects.toThrow(
      /text is required/
    );
    await expect(
      svc.sendUserPost(A, { text: "x".repeat(20_001) })
    ).rejects.toBeInstanceOf(StreamValidationError);
    await expect(
      svc.sendUserPost(A, { text: "hi", allowInert: false })
    ).rejects.toBeInstanceOf(StreamConflictError);
    const recorded = await svc.sendUserPost(A, { text: "hi" });
    expect(recorded).toMatchObject({
      delivered: false,
      held: false,
      block: { text: "hi", delivered: false },
    });
    const rows = await pool.query("SELECT text, delivered FROM blocks");
    expect(rows.rows).toEqual([{ text: "hi", delivered: false }]);
  });

  it("stores under a client-minted id and refuses a repeat of it", async () => {
    const { svc } = build();
    const id = "7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5";
    const first = await svc.sendUserPost(A, { id, text: "hello" });
    expect(first.block.id).toBe(id);
    await expect(
      svc.sendUserPost(A, { id, text: "again" })
    ).rejects.toBeInstanceOf(StreamConflictError);
    await svc.waitForInFlightDeliveries(1_000);
  });

  it("rejects an unknown recipient before writing", async () => {
    const { svc, injected } = build();
    await expect(svc.sendUserPost("agt_nobody", { text: "x" })).rejects.toThrow(
      /Agent agt_nobody not found/
    );
    await expect(
      svc.sendUserPost(A, { text: "x", to: "agt_nobody" })
    ).rejects.toThrow(/not found/);
    expect(injected).toEqual([]);
    expect((await pool.query("SELECT 1 FROM blocks")).rowCount).toBe(0);
  });

  it("resolves user attachments and lists them in the envelope", async () => {
    const fileId = await seedFiles(
      A,
      "shot-2026-01-01-00-00-00-000.png",
      122880
    );
    const { svc, injected } = build();
    const res = await svc.sendUserPost(A, {
      text: "look at this",
      attachments: [
        { type: "file", fileId },
        { type: "link", url: "https://example.com/spec", title: "Spec" },
      ],
    });
    expect(res.block.attachments).toEqual([
      {
        type: "file",
        fileId,
        fileName: "shot-2026-01-01-00-00-00-000.png",
        sizeBytes: 122880,
        mimeType: "image/png",
        media: "image",
        ownerAgentId: A,
      },
      { type: "link", url: "https://example.com/spec", title: "Spec" },
    ]);
    await settled(svc, res.block.id);
    expect(injected[0]?.text).toBe(
      [
        `--- DISPATCH POST (id: ${res.block.id}, from: user) ---`,
        "look at this",
        "",
        "Attachments:",
        "- file: /files-root/agt_stream_svc/shot-2026-01-01-00-00-00-000.png (image/png, 120 KB)",
        "- link: https://example.com/spec — Spec",
        "--- END DISPATCH POST ---",
        "Your reply appears in the stream as you write it. Use post only for a question with options, a file, a link, or to reach another agent.",
      ].join("\n")
    );
  });

  it("accepts blank text with an attachment and lists only the attachments", async () => {
    const { svc, injected } = build();
    const res = await svc.sendUserPost(A, {
      text: "",
      attachments: [{ type: "link", url: "https://example.com" }],
    });
    expect(res.block.text).toBe("");
    await settled(svc, res.block.id);
    expect(injected[0]?.text).toContain(
      `--- DISPATCH POST (id: ${res.block.id}, from: user) ---\nAttachments:\n- link: https://example.com\n--- END DISPATCH POST ---`
    );
  });

  it("rejects unknown files and too many attachments before writing", async () => {
    const { svc, injected } = build();
    await expect(
      svc.sendUserPost(A, {
        text: "x",
        attachments: [{ type: "file", fileId: 999_999 }],
      })
    ).rejects.toThrow(/Unknown file #999999/);
    await expect(
      svc.sendUserPost(A, {
        text: "x",
        attachments: Array.from({ length: 21 }, () => ({
          type: "link" as const,
          url: "https://example.com",
        })),
      })
    ).rejects.toThrow(/20 entries or fewer/);
    expect((await pool.query("SELECT 1 FROM blocks")).rowCount).toBe(0);
    expect(injected).toHaveLength(0);
  });

  it("delivers a post addressed to another agent on the stream", async () => {
    const { svc, injected } = build();
    const res = await svc.sendUserPost(A, { text: "you too", to: B });
    expect(res.block).toMatchObject({ streamId: A, toAgentId: B });
    await settled(svc, res.block.id);
    expect(injected).toEqual([
      { agentId: B, text: expect.stringContaining("from: user") },
    ]);
  });

  it("leaves a person's review top-level, under its client id, with findings by the person, and delivers it", async () => {
    const { svc, injected } = build();
    const id = "3d2c1b0a-9f8e-4d7c-8b6a-5f4e3d2c1b0a";
    const res = await svc.sendUserPost(A, {
      id,
      text: "",
      review: {
        summary: "Two things.",
        findings: [
          {
            severity: "major",
            title: "Guard",
            body: "Null here.",
            path: "a.ts",
            line: 4,
          },
          { severity: "nit", title: "Name", body: "Rename." },
        ],
      },
    });
    expect(res.block).toMatchObject({
      id,
      kind: "review",
      author: { kind: "user" },
      toAgentId: A,
      threadId: null,
      data: { summary: "Two things." },
    });
    const findings = res.block.blocks!;
    expect(findings).toMatchObject([
      {
        kind: "finding",
        author: { kind: "user" },
        toAgentId: A,
        threadId: id,
        data: { title: "Guard", path: "a.ts", line: 4 },
        state: { status: "open", by: { kind: "user" } },
      },
      { kind: "finding", data: { title: "Name" } },
    ]);
    expect(res.block.state).toEqual({ blocks: findings.map((f) => f.id) });
    await settled(svc, id);
    expect(injected.map((i) => i.agentId)).toEqual([A]);
    expect(injected[0]!.text).toContain(
      `Review (id: ${id}): 2 of 2 findings open.`
    );
    expect(injected[0]!.text).toContain(
      `1. [major] Guard (id: ${findings[0]!.id}, open) — a.ts:4`
    );
    // A person's review has no author agent: a comment on its finding by
    // the agent whose work it is goes nowhere but the stream.
    const answer = await svc.post(A, {
      text: "Guarded.",
      replyTo: findings[0]!.id,
    });
    expect(answer).toMatchObject({
      threadId: findings[0]!.id,
      toAgentId: null,
    });
    // The person is its reviewer: resolving it asks nothing of the agent,
    // so the agent is not told; reopening it is the agent's move again.
    injected.length = 0;
    await svc.setState(
      A,
      findings[0]!.id,
      { status: "fixed" },
      { kind: "user" }
    );
    await svc.waitForInFlightDeliveries(1_000);
    expect(injected).toEqual([]);
    await svc.setState(
      A,
      findings[0]!.id,
      { status: "open", note: "Not quite." },
      { kind: "user" }
    );
    await svc.waitForInFlightDeliveries(1_000);
    expect(injected.map((i) => i.agentId)).toEqual([A]);
    expect(injected[0]!.text).toContain('Finding "Guard" reopened: Not quite.');
  });

  it("replies in a thread: the root is republished with its count, the envelope names the thread", async () => {
    const { svc, events, injected } = build();
    const root = await svc.post(A, { text: "Here is the plan." });
    events.length = 0;
    const res = await svc.sendUserPost(A, {
      text: "Looks right.",
      replyTo: root.id,
    });
    expect(res.block).toMatchObject({
      threadId: root.id,
      replyTo: root.id,
      toAgentId: A,
    });
    expect(
      events.map((e) => (e as { entry: { id: string } }).entry.id)
    ).toEqual([res.block.id, root.id]);
    expect(
      (events[1] as { entry: { block: Block } }).entry.block.replyCount
    ).toBe(1);
    await settled(svc, res.block.id);
    expect(injected[0]?.text).toContain(`In the thread under ${root.id}.`);
    expect(injected[0]?.text).toContain(
      `Your reply appears in this thread as you write it.`
    );
    expect(injected[0]?.text).toContain(
      `(with replyTo: "${root.id}" to keep it in this thread)`
    );
    // A reply to the reply keeps the root.
    const nested = await svc.sendUserPost(A, {
      text: "more",
      replyTo: res.block.id,
    });
    expect(nested.block).toMatchObject({
      threadId: root.id,
      replyTo: res.block.id,
    });
    await settled(svc, nested.block.id);
    await expect(
      svc.sendUserPost(A, { text: "x", replyTo: NIL })
    ).rejects.toThrow(/on this stream/);
    await expect(
      svc.sendUserPost(A, { text: "x", replyTo: "nope" })
    ).rejects.toThrow(/replyTo must be a block id/);
  });
});

describe("StreamService.answerQuestion", () => {
  async function ask(svc: StreamService, allowFreeform = false) {
    return svc.post(A, {
      text: "Ship it?",
      question: {
        options: [{ label: "Yes", value: "yes" }, { label: "No" }],
        ...(allowFreeform ? { allowFreeform: true } : {}),
      },
    });
  }

  it("resolves the option label, records the answer in one transaction, and delivers", async () => {
    const { svc, injected, events } = build();
    const q = await ask(svc);
    events.length = 0;
    const res = await svc.answerQuestion(A, q.id, {
      value: "yes",
      label: "ignored for option answers",
    });
    expect(res.delivered).toBeNull();
    expect(res.reply).toMatchObject({
      author: { kind: "user" },
      toAgentId: A,
      kind: "text",
      text: "Yes",
      threadId: q.id,
      replyTo: q.id,
      delivered: null,
    });
    expect(res.block.kind === "question" && res.block.state.answer).toEqual({
      value: "yes",
      label: "Yes",
      by: { kind: "user" },
      blockId: res.reply.id,
      at: expect.any(String),
    });
    // The answered question, then the reply (a thread block, filed into
    // the thread by the client), then the question again as the thread's
    // root with its reply count.
    expect(events.slice(0, 3)).toEqual([
      expect.objectContaining({
        type: "stream.entry",
        entry: expect.objectContaining({
          id: q.id,
          block: expect.objectContaining({ state: res.block.state }),
        }),
      }),
      expect.objectContaining({
        type: "stream.entry",
        entry: expect.objectContaining({ id: res.reply.id }),
      }),
      expect.objectContaining({
        type: "stream.entry",
        entry: expect.objectContaining({
          id: q.id,
          block: expect.objectContaining({ replyCount: 1 }),
        }),
      }),
    ]);
    expect((await settled(svc, res.reply.id)).delivered).toBe(true);
    expect(injected[0]?.text).toBe(
      [
        `--- DISPATCH POST (id: ${res.reply.id}, from: user) ---`,
        "Yes",
        `This answers your question ${q.id}. In the thread under ${q.id}.`,
        "--- END DISPATCH POST ---",
        `Your reply appears in this thread as you write it. Use post only for a question with options, a file, a link, or to reach another agent (with replyTo: "${q.id}" to keep it in this thread).`,
      ].join("\n")
    );
    // Value-less options match on their label; but the question is taken.
    await expect(
      svc.answerQuestion(A, q.id, { value: "No" })
    ).rejects.toBeInstanceOf(StreamConflictError);
    expect((await svc.store.listThread(q.id))?.replies).toHaveLength(1);
  });

  it("maps missing, foreign, non-question, and bad values to domain errors", async () => {
    const { svc } = build();
    await expect(
      svc.answerQuestion(A, "not-a-uuid", { value: "a" })
    ).rejects.toThrow(/blockId must be a UUID/);
    await expect(
      svc.answerQuestion(A, NIL, { value: "a" })
    ).rejects.toBeInstanceOf(StreamNotFoundError);
    const plain = await svc.post(A, { text: "not a question" });
    await expect(
      svc.answerQuestion(A, plain.id, { value: "a" })
    ).rejects.toBeInstanceOf(StreamNotFoundError);
    const q = await ask(svc);
    await expect(
      svc.answerQuestion(B, q.id, { value: "yes" })
    ).rejects.toBeInstanceOf(StreamNotFoundError);
    await expect(svc.answerQuestion(A, q.id, { value: "  " })).rejects.toThrow(
      /value is required/
    );
    await expect(
      svc.answerQuestion(A, q.id, { value: "typed" })
    ).rejects.toThrow(/does not match one of the question's options/);
    const after = await svc.store.getById(q.id);
    expect(after?.kind === "question" && after.state).toEqual({});
    await svc.waitForInFlightDeliveries(1_000);
  });

  it("accepts a freeform answer with a trimmed, bounded label", async () => {
    const { svc } = build();
    const q = await ask(svc, true);
    const res = await svc.answerQuestion(A, q.id, {
      value: "something typed",
      label: `  ${"t".repeat(300)}  `,
    });
    expect(res.reply.text).toBe("something typed");
    expect(
      res.block.kind === "question" && res.block.state.answer
    ).toMatchObject({
      value: "something typed",
      label: "t".repeat(200),
    });
    await svc.waitForInFlightDeliveries(1_000);
    const q2 = await ask(svc, true);
    const bare = await svc.answerQuestion(A, q2.id, {
      value: "typed",
      label: "  ",
    });
    expect(
      bare.block.kind === "question" && bare.block.state.answer
    ).not.toHaveProperty("label");
    await expect(
      svc.answerQuestion(A, (await ask(svc, true)).id, {
        value: "x".repeat(20_001),
      })
    ).rejects.toThrow(/20000 characters or fewer/);
    await svc.waitForInFlightDeliveries(1_000);
  });

  it("stores attachments on the reply and lists them in the envelope", async () => {
    const fileId = await seedFiles(
      A,
      "shot-2026-01-01-00-00-00-000.png",
      122880
    );
    const { svc, injected } = build();
    const q = await ask(svc, true);
    const res = await svc.answerQuestion(A, q.id, {
      value: "this one",
      attachments: [
        { type: "file", fileId },
        { type: "link", url: "https://example.com/spec", title: "Spec" },
      ],
    });
    expect(res.reply.attachments).toEqual([
      {
        type: "file",
        fileId,
        fileName: "shot-2026-01-01-00-00-00-000.png",
        sizeBytes: 122880,
        mimeType: "image/png",
        media: "image",
        ownerAgentId: A,
      },
      { type: "link", url: "https://example.com/spec", title: "Spec" },
    ]);
    expect((await svc.store.getById(res.reply.id))?.attachments).toEqual(
      res.reply.attachments
    );
    await settled(svc, res.reply.id);
    expect(injected[0]?.text).toContain(
      [
        `--- DISPATCH POST (id: ${res.reply.id}, from: user) ---`,
        "this one",
        "",
        "Attachments:",
        "- file: /files-root/agt_stream_svc/shot-2026-01-01-00-00-00-000.png (image/png, 120 KB)",
        "- link: https://example.com/spec — Spec",
        `This answers your question ${q.id}. In the thread under ${q.id}.`,
        "--- END DISPATCH POST ---",
      ].join("\n")
    );
  });

  it("rejects unknown files and too many attachments before writing", async () => {
    const { svc, injected } = build();
    const q = await ask(svc, true);
    await expect(
      svc.answerQuestion(A, q.id, {
        value: "x",
        attachments: [{ type: "file", fileId: 999_999 }],
      })
    ).rejects.toThrow(/Unknown file #999999/);
    await expect(
      svc.answerQuestion(A, q.id, {
        value: "x",
        attachments: Array.from({ length: 21 }, () => ({
          type: "link" as const,
          url: "https://example.com",
        })),
      })
    ).rejects.toThrow(/20 entries or fewer/);
    expect((await svc.store.getById(q.id))?.state).toEqual({});
    const rows = await pool.query(
      "SELECT 1 FROM blocks WHERE author_kind = 'user'"
    );
    expect(rows.rowCount).toBe(0);
    expect(injected).toHaveLength(0);
  });

  it("records an undelivered answer when the agent is inert", async () => {
    const { svc, injected } = build({ access: inert });
    const q = await ask(svc);
    const res = await svc.answerQuestion(A, q.id, { value: "No" });
    expect(res).toMatchObject({
      delivered: false,
      reply: { text: "No", delivered: false },
    });
    expect(injected).toEqual([]);
  });

  it("leaves exactly one reply when answers race", async () => {
    const { svc } = build();
    const q = await ask(svc);
    const results = await Promise.allSettled(
      ["yes", "No", "yes", "No"].map((value) =>
        svc.answerQuestion(A, q.id, { value })
      )
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected")
        expect(r.reason).toBeInstanceOf(StreamConflictError);
    }
    const replies = await pool.query<{ id: string }>(
      `SELECT id FROM blocks WHERE reply_to = $1`,
      [q.id]
    );
    expect(replies.rows).toHaveLength(1);
    const winner = results.find(
      (r) => r.status === "fulfilled"
    )! as PromiseFulfilledResult<
      Awaited<ReturnType<StreamService["answerQuestion"]>>
    >;
    expect(replies.rows[0].id).toBe(winner.value.reply.id);
    await svc.waitForInFlightDeliveries(1_000);
  });

  it("refuses a client id that is already taken and leaves the question open", async () => {
    const { svc } = build();
    const q = await ask(svc);
    const taken = await svc.post(A, { text: "taken" });
    await expect(
      svc.answerQuestion(A, q.id, { id: taken.id, value: "yes" })
    ).rejects.toBeInstanceOf(StreamConflictError);
    expect((await svc.store.getById(q.id))?.state).toEqual({});
    const minted = "1e1e1e1e-2d2d-4c3c-8b4b-5a5a5a5a5a5a";
    const res = await svc.answerQuestion(A, q.id, { id: minted, value: "yes" });
    expect(res.reply.id).toBe(minted);
    await svc.waitForInFlightDeliveries(1_000);
  });
});

describe("StreamService.submitForm", () => {
  const FIELDS = [
    { id: "name", label: "Name", type: "text" as const, required: true },
    { id: "count", label: "Count", type: "number" as const },
    { id: "ok", label: "Ready", type: "checkbox" as const },
    {
      id: "size",
      label: "Size",
      type: "select" as const,
      options: [{ label: "S" }, { label: "M" }],
    },
  ];

  it("records the submission, lists the values as the reply, and delivers", async () => {
    const { svc, injected, events } = build();
    const form = await svc.post(A, {
      form: { title: "Details", fields: FIELDS },
    });
    events.length = 0;
    const res = await svc.submitForm(A, form.id, {
      values: { name: "Ada", count: 2, ok: true, unknown: "dropped", size: "" },
    });
    expect(res.delivered).toBeNull();
    expect(res.reply).toMatchObject({
      author: { kind: "user" },
      toAgentId: A,
      threadId: form.id,
      replyTo: form.id,
      text: "Name: Ada\nCount: 2\nReady: true",
      delivered: null,
    });
    expect(res.block.kind === "form" && res.block.state.submission).toEqual({
      values: { name: "Ada", count: 2, ok: true },
      by: { kind: "user" },
      blockId: res.reply.id,
      at: expect.any(String),
    });
    expect(
      events.map((e) => (e as { entry: { id: string } }).entry.id)
    ).toEqual([form.id, res.reply.id, form.id]);
    expect((await settled(svc, res.reply.id)).delivered).toBe(true);
    expect(injected[0]?.text).toBe(
      [
        `--- DISPATCH POST (id: ${res.reply.id}, from: user) ---`,
        "Name: Ada\nCount: 2\nReady: true",
        `This answers your form ${form.id}. In the thread under ${form.id}.`,
        "--- END DISPATCH POST ---",
        `Your reply appears in this thread as you write it. Use post only for a question with options, a file, a link, or to reach another agent (with replyTo: "${form.id}" to keep it in this thread).`,
      ].join("\n")
    );
    await expect(
      svc.submitForm(A, form.id, { values: { name: "B" } })
    ).rejects.toThrow(/already submitted/);
  });

  it("requires required fields and maps missing or foreign forms to errors", async () => {
    const { svc, injected } = build();
    const form = await svc.post(A, { form: { fields: FIELDS } });
    await expect(svc.submitForm(A, form.id, { values: {} })).rejects.toThrow(
      /"Name" is required/
    );
    await expect(
      svc.submitForm(A, form.id, { values: { name: "" } })
    ).rejects.toThrow(/"Name" is required/);
    await expect(
      svc.submitForm(A, "nope", { values: {} })
    ).rejects.toBeInstanceOf(StreamNotFoundError);
    await expect(svc.submitForm(A, NIL, { values: {} })).rejects.toBeInstanceOf(
      StreamNotFoundError
    );
    await expect(
      svc.submitForm(B, form.id, { values: { name: "x" } })
    ).rejects.toBeInstanceOf(StreamNotFoundError);
    const q = await svc.post(A, { question: { options: [{ label: "a" }] } });
    await expect(
      svc.submitForm(A, q.id, { values: {} })
    ).rejects.toBeInstanceOf(StreamNotFoundError);
    expect((await svc.store.getById(form.id))?.state).toEqual({});
    expect(injected).toEqual([]);
  });

  it("records an undelivered submission when the agent is inert", async () => {
    const { svc } = build({ access: inert });
    const form = await svc.post(A, { form: { fields: FIELDS } });
    const res = await svc.submitForm(A, form.id, { values: { name: "Ada" } });
    expect(res).toMatchObject({
      delivered: false,
      reply: { delivered: false },
    });
  });

  it("leaves exactly one reply when submissions race, and honours a client id", async () => {
    const { svc } = build();
    const form = await svc.post(A, { form: { fields: FIELDS } });
    const results = await Promise.allSettled(
      ["a", "b", "c"].map((name) =>
        svc.submitForm(A, form.id, { values: { name } })
      )
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const replies = await pool.query(
      `SELECT id FROM blocks WHERE reply_to = $1`,
      [form.id]
    );
    expect(replies.rows).toHaveLength(1);

    const second = await svc.post(A, { form: { fields: FIELDS } });
    const taken = await svc.post(A, { text: "taken" });
    await expect(
      svc.submitForm(A, second.id, { id: taken.id, values: { name: "x" } })
    ).rejects.toBeInstanceOf(StreamConflictError);
    expect((await svc.store.getById(second.id))?.state).toEqual({});
    const minted = "2e1e1e1e-2d2d-4c3c-8b4b-5a5a5a5a5a5a";
    const res = await svc.submitForm(A, second.id, {
      id: minted,
      values: { name: "x" },
    });
    expect(res.reply.id).toBe(minted);
    await svc.waitForInFlightDeliveries(1_000);
  });
});

describe("StreamService cancellation (question/form state.cancellation)", () => {
  async function ask(svc: StreamService, to?: string) {
    return svc.post(A, {
      text: "Ship it?",
      ...(to ? { to } : {}),
      question: { options: [{ label: "Yes" }, { label: "No" }] },
    });
  }

  async function form(svc: StreamService, to?: string) {
    return svc.post(A, {
      ...(to ? { to } : {}),
      form: { fields: [{ id: "name", label: "Name", type: "text" }] },
    });
  }

  it("the author cancels its own question addressed to the user: no delivery, one note, idempotent", async () => {
    const { svc, injected, events } = build();
    const q = await ask(svc);
    events.length = 0;
    const canceled = await svc.update(A, q.id, {
      state: { cancellation: true },
    });
    expect(canceled.kind === "question" && canceled.state.cancellation).toEqual(
      {
        by: { kind: "agent", agentId: A },
        at: expect.any(String),
      }
    );
    const thread = await svc.store.listThread(q.id);
    expect(thread?.replies).toHaveLength(1);
    expect(thread?.replies[0]).toMatchObject({
      author: { kind: "agent", agentId: A },
      text: "Canceled.",
      replyTo: q.id,
      toAgentId: null,
    });
    // Addressed to the user: no agent to notify.
    await svc.waitForInFlightDeliveries(1_000);
    expect(injected).toEqual([]);
    // Retrying is a no-op: same block back, no second note.
    const again = await svc.update(A, q.id, { state: { cancellation: true } });
    expect(again).toEqual(canceled);
    expect((await svc.store.listThread(q.id))?.replies).toHaveLength(1);
  });

  it("records a short reason in the state and the note", async () => {
    const { svc } = build();
    const q = await ask(svc);
    const canceled = await svc.update(A, q.id, {
      state: { cancellation: { reason: "  Switched approaches.  " } },
    });
    expect(
      canceled.kind === "question" && canceled.state.cancellation?.reason
    ).toBe("Switched approaches.");
    const thread = await svc.store.listThread(q.id);
    expect(thread?.replies[0].text).toBe("Canceled: Switched approaches.");
    // A bare reason string works the same way.
    const q2 = await ask(svc);
    const canceled2 = await svc.update(A, q2.id, {
      state: { cancellation: "no longer relevant" },
    });
    expect(
      canceled2.kind === "question" && canceled2.state.cancellation?.reason
    ).toBe("no longer relevant");
  });

  it("cancels a form the same way", async () => {
    const { svc } = build();
    const f = await form(svc);
    const canceled = await svc.update(A, f.id, {
      state: { cancellation: true },
    });
    expect(canceled.kind === "form" && canceled.state.cancellation).toEqual({
      by: { kind: "agent", agentId: A },
      at: expect.any(String),
    });
    expect((await svc.store.listThread(f.id))?.replies).toHaveLength(1);
  });

  it("notifies the addressee when the author cancels an ask sent to another agent", async () => {
    const { svc, injected } = build();
    const q = await ask(svc, B);
    await settled(svc, q.id);
    const canceled = await svc.update(A, q.id, {
      state: { cancellation: { reason: "handled elsewhere" } },
    });
    await svc.waitForInFlightDeliveries(1_000);
    expect(injected).toContainEqual({
      agentId: B,
      text: expect.stringContaining("Canceled: handled elsewhere"),
    });
    const thread = await svc.store.listThread(canceled.id);
    expect(thread?.replies[0].toAgentId).toBe(B);
  });

  it("commits cancellation when its notification recipient is unavailable", async () => {
    const { svc, injected } = build({
      access: async (id) => {
        if (id === A) throw new Error("agent stopped");
        return { mode: "live" as const };
      },
    });
    const q = await ask(svc);
    const canceled = await svc.setState(
      A,
      q.id,
      { cancellation: true },
      { kind: "user" }
    );
    expect(canceled.state?.cancellation).toBeDefined();
    const note = (await svc.store.listThread(q.id))?.replies[0];
    expect(note).toMatchObject({ toAgentId: A, delivered: false });
    expect(injected).toEqual([]);
  });

  it("the user cancels a question or form addressed to them and the asking agent is told", async () => {
    const { svc, injected } = build();
    const q = await ask(svc);
    const canceled = await svc.setState(
      A,
      q.id,
      { cancellation: true },
      { kind: "user" }
    );
    expect(
      canceled.kind === "question" && canceled.state.cancellation?.by
    ).toEqual({ kind: "user" });
    await svc.waitForInFlightDeliveries(1_000);
    expect(injected).toContainEqual({
      agentId: A,
      text: expect.stringContaining("Canceled."),
    });
    const f = await form(svc);
    const canceledForm = await svc.setState(
      A,
      f.id,
      { cancellation: "not needed" },
      { kind: "user" }
    );
    expect(
      canceledForm.kind === "form" && canceledForm.state.cancellation?.reason
    ).toBe("not needed");
  });

  it("refuses everyone but the author or the addressed user", async () => {
    const { svc } = build();
    const q = await ask(svc);
    // Not the author.
    await expect(
      svc.update(B, q.id, { state: { cancellation: true } })
    ).rejects.toBeInstanceOf(StreamForbiddenError);
    // A question addressed to another agent: that agent may not cancel it,
    // only the author (or, if it were addressed to the user, the user).
    const toB = await ask(svc, B);
    await expect(
      svc.setState(
        A,
        toB.id,
        { cancellation: true },
        { kind: "agent", agentId: B }
      )
    ).rejects.toBeInstanceOf(StreamForbiddenError);
    // The user may not cancel an ask addressed to another agent.
    await expect(
      svc.setState(A, toB.id, { cancellation: true }, { kind: "user" })
    ).rejects.toBeInstanceOf(StreamForbiddenError);
  });

  it("rejects canceling something already answered or submitted, and answering/submitting something canceled", async () => {
    const { svc } = build();
    const q = await ask(svc);
    await svc.answerQuestion(A, q.id, { value: "Yes" });
    await expect(
      svc.update(A, q.id, { state: { cancellation: true } })
    ).rejects.toThrow(/already answered/);

    const f = await form(svc);
    await svc.submitForm(A, f.id, { values: { name: "Ada" } });
    await expect(
      svc.update(A, f.id, { state: { cancellation: true } })
    ).rejects.toThrow(/already submitted/);

    const q2 = await ask(svc);
    await svc.update(A, q2.id, { state: { cancellation: true } });
    await expect(
      svc.answerQuestion(A, q2.id, { value: "Yes" })
    ).rejects.toThrow(/canceled/);
    await expect(
      svc.update(A, q2.id, { state: { answer: "Yes" } })
    ).rejects.toThrow(/canceled/);

    const f2 = await form(svc);
    await svc.update(A, f2.id, { state: { cancellation: true } });
    await expect(
      svc.submitForm(A, f2.id, { values: { name: "Ada" } })
    ).rejects.toThrow(/canceled/);
  });

  it("rejects a malformed cancellation value", async () => {
    const { svc } = build();
    const q = await ask(svc);
    await expect(
      svc.update(A, q.id, { state: { cancellation: false } })
    ).rejects.toThrow(/state\.cancellation must be/);
    await expect(
      svc.update(A, q.id, { state: { cancellation: { reason: 5 } } })
    ).rejects.toThrow(/reason must be a string/);
  });

  it("rejects a cancellation bundled with other mutations without writing them", async () => {
    const { svc } = build();
    const q = await ask(svc);
    await expect(
      svc.update(A, q.id, {
        text: "changed",
        state: { cancellation: true },
      })
    ).rejects.toThrow(/on its own/);
    await expect(
      svc.update(A, q.id, {
        state: { cancellation: true, note: "changed" },
      })
    ).rejects.toThrow(/on its own/);
    expect((await svc.store.getById(q.id))?.text).toBe("Ship it?");
    expect(
      (await svc.store.getById(q.id))?.state?.cancellation
    ).toBeUndefined();
    expect((await svc.store.listThread(q.id))?.replies).toHaveLength(0);
  });

  it("rolls back an answer reply if cancellation wins before its state write", async () => {
    const { svc, injected } = build();
    await pool.query(`UPDATE agents SET parent_agent_id = $1 WHERE id = $2`, [
      A,
      B,
    ]);
    try {
      const q = await ask(svc, B);
      await settled(svc, q.id);
      const originalWithClient = svc.store.withClient.bind(svc.store);
      let intercept = true;
      vi.spyOn(svc.store, "withClient").mockImplementation((client) => {
        const tx = originalWithClient(client);
        if (intercept) {
          intercept = false;
          const originalRecordAnswer = tx.recordAnswer.bind(tx);
          vi.spyOn(tx, "recordAnswer").mockImplementation(
            async (id, answer) => {
              await svc.update(A, q.id, { state: { cancellation: true } });
              return originalRecordAnswer(id, answer);
            }
          );
        }
        return tx;
      });
      await expect(
        svc.post(B, { text: "Yes", replyTo: q.id })
      ).rejects.toBeInstanceOf(StreamConflictError);
      const final = await svc.store.getById(q.id);
      expect(final?.state?.cancellation).toBeDefined();
      expect(final?.state?.answer).toBeUndefined();
      expect((await svc.store.listThread(q.id))?.replies).toHaveLength(1);
      expect((await svc.store.listThread(q.id))?.replies[0].text).toBe(
        "Canceled."
      );
      await svc.waitForInFlightDeliveries(1_000);
      expect(injected.some((entry) => entry.text.includes("Yes"))).toBe(false);
    } finally {
      await pool.query(
        `UPDATE agents SET parent_agent_id = NULL WHERE id = $1`,
        [B]
      );
    }
  });

  it("a cancel racing an answer leaves exactly one winner and one note/reply", async () => {
    const { svc } = build();
    const q = await ask(svc);
    const results = await Promise.allSettled([
      svc.answerQuestion(A, q.id, { value: "Yes" }),
      svc.setState(A, q.id, { cancellation: true }, { kind: "user" }),
      svc.setState(A, q.id, { cancellation: true }, { kind: "user" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const final = await svc.store.getById(q.id);
    const state = final?.kind === "question" ? final.state : null;
    // Exactly one of answer/cancellation won; never both.
    expect(Boolean(state?.answer) !== Boolean(state?.cancellation)).toBe(true);
    const thread = await svc.store.listThread(q.id);
    // The winning side left exactly one reply/note in the thread.
    expect(thread?.replies).toHaveLength(1);
  });
});

describe("StreamService.setState", () => {
  /** A review and its two findings, `a` (major) and `c` (minor). */
  async function review(
    svc: StreamService,
    author = A,
    to: string | null = null
  ) {
    const r = await svc.post(author, {
      ...(to ? { to } : {}),
      review: {
        summary: "s",
        findings: [
          { severity: "major", title: "a", body: "b" },
          { severity: "minor", title: "c", body: "d" },
        ],
      },
    });
    const [f1, f2] = r.blocks!;
    return { r, f1: f1!, f2: f2! };
  }

  it("lets a person resolve a finding, stamped, replacing its record, and tells the author", async () => {
    const { svc, events, injected } = build();
    const { r, f1, f2 } = await review(svc);
    events.length = 0;
    const updated = await svc.setState(
      A,
      f1.id,
      { status: "resolved" },
      { kind: "user" }
    );
    expect(updated.state).toEqual({
      status: "resolved",
      resolution: "fixed",
      by: { kind: "user" },
      at: expect.any(String),
    });
    // The other finding is its own block, untouched.
    expect((await svc.store.getById(f2.id))!.state).toEqual(f2.state);
    // The finding is published, then the review that shows it.
    expect(
      events.map((e) => (e as { entry: { id: string } }).entry.id)
    ).toEqual([f1.id, r.id]);
    expect(events[0]).toEqual(entryEvent(updated));
    await svc.waitForInFlightDeliveries(1_000);
    expect(injected).toHaveLength(1);
    expect(injected[0]!.agentId).toBe(A);
    expect(injected[0]!.text).toContain(
      [
        `--- DISPATCH POST (id: ${f1.id}, from: user) ---`,
        'Finding "a" fixed.',
        "Nothing to do unless you disagree; reopen it with a note if so.",
        // An answer goes under the finding: it is its own thread.
        `In the thread under ${f1.id}.`,
        "--- END DISPATCH POST ---",
      ].join("\n")
    );
    // Reopen with a note, and dismiss the other with one.
    const again = await svc.setState(
      A,
      f1.id,
      { status: "open", note: "Still spins after a timeout." },
      { kind: "user" }
    );
    expect(again.state).toEqual({
      status: "open",
      note: "Still spins after a timeout.",
      by: { kind: "user" },
      at: expect.any(String),
    });
    const dismissed = await svc.setState(
      A,
      f2.id,
      { status: "resolved", resolution: "dismissed", note: "Not ours." },
      { kind: "user" }
    );
    expect(dismissed.state).toMatchObject({
      status: "resolved",
      resolution: "dismissed",
      note: "Not ours.",
    });
    await svc.waitForInFlightDeliveries(1_000);
    expect(injected[1]?.text).toContain(
      'Finding "a" reopened: Still spins after a timeout.\nThe agent whose work it is will answer under it.'
    );
    expect(injected[2]?.text).toContain('Finding "c" dismissed: Not ours.');
  });

  it("ticks tasks the same way", async () => {
    const { svc, injected } = build();
    const tasks = await svc.post(A, {
      tasks: {
        items: [
          { id: "t1", text: "a" },
          { id: "t2", text: "b" },
        ],
      },
    });
    const updated = await svc.setState(
      A,
      tasks.id,
      { items: { t2: "done" } },
      { kind: "user" }
    );
    expect(updated.state).toEqual({ items: { t1: "todo", t2: "done" } });
    await svc.waitForInFlightDeliveries(1_000);
    expect(injected[0]?.text).toContain("Task t2 is now done.");
  });

  it("says nothing to an inert author, and nothing when the author changed it", async () => {
    const inertSvc = build({ access: inert });
    const { f1 } = await review(inertSvc.svc);
    await inertSvc.svc.setState(
      A,
      f1.id,
      { status: "resolved" },
      { kind: "user" }
    );
    expect(inertSvc.injected).toEqual([]);
    const { svc, injected } = build();
    const own = await review(svc);
    await svc.setState(
      A,
      own.f1.id,
      { status: "resolved" },
      { kind: "agent", agentId: A }
    );
    await svc.waitForInFlightDeliveries(1_000);
    expect(injected).toEqual([]);
  });

  it("allows the author and the recipient, and no other agent, and tells the other side", async () => {
    const { svc, injected } = build();
    // B's review of A's work: B is a root agent, so it lives on B's stream.
    const { r, f1, f2 } = await review(svc, B, A);
    expect(r).toMatchObject({ streamId: B, threadId: null, toAgentId: A });
    await settled(svc, r.id);
    injected.length = 0;
    await expect(
      svc.setState(
        B,
        f1.id,
        { status: "resolved" },
        { kind: "agent", agentId: "agt_third" }
      )
    ).rejects.toBeInstanceOf(StreamForbiddenError);
    const byRecipient = await svc.setState(
      B,
      f1.id,
      { status: "resolved" },
      { kind: "agent", agentId: A }
    );
    expect(byRecipient.state).toMatchObject({
      status: "resolved",
      by: { kind: "agent", agentId: A },
    });
    await svc.waitForInFlightDeliveries(1_000);
    // The reviewer hears of it, on the finding's own thread.
    expect(injected).toEqual([
      {
        agentId: B,
        text: expect.stringContaining(
          `--- DISPATCH POST (id: ${f1.id}, from: Svc (${A})) ---`
        ),
      },
    ]);
    expect(injected[0]!.text).toContain(`replyTo: "${f1.id}"`);
    injected.length = 0;
    const byAuthor = await svc.setState(
      B,
      f2.id,
      { status: "resolved" },
      { kind: "agent", agentId: B }
    );
    expect(byAuthor.state).toMatchObject({
      status: "resolved",
      by: { kind: "agent", agentId: B },
    });
    await svc.waitForInFlightDeliveries(1_000);
    // The reviewer settling its own finding asks nothing of the builder:
    // no notification (each one would cost the builder a turn).
    expect(injected).toEqual([]);
    // Dismissed by the reviewer: the same.
    await svc.setState(
      B,
      f2.id,
      { status: "dismissed", note: "On reflection, fine." },
      { kind: "agent", agentId: B }
    );
    await svc.waitForInFlightDeliveries(1_000);
    expect(injected).toEqual([]);
    // The reviewer reopening tells the builder it is its move.
    injected.length = 0;
    await svc.setState(
      B,
      f1.id,
      { status: "open", note: "Still wrong." },
      { kind: "agent", agentId: B }
    );
    await svc.waitForInFlightDeliveries(1_000);
    expect(injected).toEqual([
      {
        agentId: A,
        text: expect.stringContaining(
          `Finding "a" reopened: Still wrong.\nIt is yours to address again: make the change and say what you changed under it, post({ replyTo: "${f1.id}", text }). Its reviewer resolves it.`
        ),
      },
    ]);
  });

  it("maps unknown or foreign blocks, stateless kinds and bad patches to errors", async () => {
    const { svc } = build();
    await expect(
      svc.setState(A, NIL, { status: "fixed" }, { kind: "user" })
    ).rejects.toBeInstanceOf(StreamNotFoundError);
    await expect(
      svc.setState(A, "nope", { status: "fixed" }, { kind: "user" })
    ).rejects.toBeInstanceOf(StreamNotFoundError);
    const { r, f1 } = await review(svc);
    await expect(
      svc.setState(B, f1.id, { status: "fixed" }, { kind: "user" })
    ).rejects.toBeInstanceOf(StreamNotFoundError);
    const text = await svc.post(A, { text: "plain" });
    await expect(
      svc.setState(A, text.id, { items: {} }, { kind: "user" })
    ).rejects.toThrow(/A text block has no state/);
    const q = await svc.post(A, { question: { options: [{ label: "a" }] } });
    await expect(
      svc.setState(A, q.id, { answer: {} }, { kind: "user" })
    ).rejects.toThrow(/A question block has no state/);
    // A review stands where its findings do: it has no state of its own to set.
    await expect(
      svc.setState(A, r.id, { status: "fixed" }, { kind: "user" })
    ).rejects.toThrow(/A review block has no state/);
    for (const bad of [
      {},
      { status: "disputed" },
      { status: "resolved", resolution: "later" },
      { status: "fixed", note: 3 },
      { findings: { f1: "fixed" } },
    ]) {
      await expect(
        svc.setState(A, f1.id, bad, { kind: "user" })
      ).rejects.toThrow(
        /A finding's state is \{ status: "open" \| "fixed" \| "dismissed", note\? \}/
      );
    }
    await expect(
      svc.setState(
        A,
        f1.id,
        { status: "fixed", note: "x".repeat(BLOCK_TEXT_MAX_CHARS + 1) },
        { kind: "user" }
      )
    ).rejects.toThrow(/note must be/);
    expect((await svc.store.getById(f1.id))!.state).toEqual(f1.state);
    expect((await svc.store.getById(r.id))!.state).toEqual(r.state);
  });
});

// ---------------------------------------------------------------------------
// Review threads: who a comment reaches, which finding it is about
// ---------------------------------------------------------------------------

describe("StreamService review threads", () => {
  // The reviewer is the builder's child, as a persona launch makes it:
  // both post into A's stream, and B's own place is its launch card.
  beforeAll(async () => {
    await pool.query(
      `UPDATE agents SET parent_agent_id = $1, launched_by_agent_id = $1 WHERE id = $2`,
      [A, B]
    );
  });
  afterAll(async () => {
    await pool.query(
      `UPDATE agents SET parent_agent_id = NULL, launched_by_agent_id = NULL WHERE id = $1`,
      [B]
    );
  });

  /**
   * B reviews A's work: the review lands on B's launch card in A's stream,
   * addressed to A, showing its two findings `a` and `c`.
   */
  /**
   * B's card, launched by A. The launcher comes only from the launch (never
   * the agent row): a launch with no briefing still records it.
   */
  async function launchChild(svc: StreamService) {
    expect(
      await svc.prepareLaunchContext({ agentId: B, launchedByAgentId: A })
    ).toBeNull();
    return (await svc.store.findLaunchBlock(B))!;
  }

  async function reviewed(svc: StreamService) {
    await launchChild(svc);
    const r = await svc.post(B, {
      to: A,
      review: {
        summary: "s",
        findings: [
          { severity: "major", title: "a", body: "b" },
          { severity: "minor", title: "c", body: "d" },
        ],
      },
    });
    await settled(svc, r.id);
    const [f1, f2] = r.blocks!;
    return { r, f1: f1!, f2: f2! };
  }

  const turnRow = (id: number, agentId: string) => ({
    id,
    agentId,
    seq: id,
    kind: "turn" as const,
    key: null,
    payload: { state: "started", prompt: { source: "chat" } },
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  it("caps option labels at button length", async () => {
    await expect(
      service.post(A, {
        text: "Which?",
        question: { options: [{ label: "x".repeat(33) }] },
      })
    ).rejects.toThrow(/Each option label must be 1–32 characters/);
    await expect(
      service.post(A, {
        text: "Which?",
        question: { options: [{ label: "  " }] },
      })
    ).rejects.toThrow(/Each option label/);
    const ok = await service.post(A, {
      text: "Which?",
      question: { options: [{ label: "  Ship it  " }] },
    });
    expect(ok.kind === "question" && ok.data.options[0]?.label).toBe("Ship it");
  });

  it("puts a child's review on its launch card, which shows it, and the review shows its findings in order", async () => {
    const { svc, injected } = build();
    const { r, f1, f2 } = await reviewed(svc);
    const card = await svc.store.findLaunchBlock(B);
    expect(card).toMatchObject({
      id: launchBlockId(B),
      streamId: A,
      toAgentId: B,
      launchedByAgentId: A,
    });
    expect(r).toMatchObject({
      kind: "review",
      streamId: A,
      author: { kind: "agent", agentId: B },
      toAgentId: A,
      threadId: card!.id,
      replyTo: card!.id,
      data: { summary: "s" },
      state: { blocks: [f1.id, f2.id] },
    });
    // The card lists the review among the blocks it shows.
    expect((await svc.store.getById(card!.id))!.state).toMatchObject({
      blocks: [r.id],
    });
    for (const [finding, title] of [
      [f1, "a"],
      [f2, "c"],
    ] as const) {
      expect(finding).toMatchObject({
        kind: "finding",
        streamId: A,
        author: { kind: "agent", agentId: B },
        toAgentId: A,
        threadId: r.id,
        replyTo: r.id,
        delivered: true,
        data: { title },
        state: { status: "open", by: { kind: "agent", agentId: B } },
      });
    }
    // One delivery: the review, carrying its findings with their ids.
    expect(injected.map((i) => i.agentId)).toEqual([A]);
    expect(injected[0]!.text).toContain(
      `Review (id: ${r.id}): 2 of 2 findings open.`
    );
    expect(injected[0]!.text).toContain(`(id: ${f1.id}, open)`);
    expect(injected[0]!.text).toContain(`(id: ${f2.id}, open)`);
  });

  it("reads the card with the review and its findings attached, and counts none of them as replies", async () => {
    const { svc } = build();
    const { r, f1, f2 } = await reviewed(svc);
    const comment = await svc.post(A, { text: "Fixed.", replyTo: f1.id });
    const feed = await composeStreamFeed(svc.store, A);
    const cardEntry = feed.entries.find(
      (e) => e.type === "block" && e.block.kind === "launch"
    ) as { block: Block } | undefined;
    expect(cardEntry).toBeDefined();
    const card = cardEntry!.block;
    expect(card.replyCount ?? 0).toBe(0);
    expect(card.blocks?.map((b) => b.id)).toEqual([r.id]);
    const shownReview = card.blocks![0]!;
    expect(shownReview.replyCount ?? 0).toBe(0);
    expect(shownReview.blocks?.map((b) => b.id)).toEqual([f1.id, f2.id]);
    // A comment under a finding counts on that finding.
    expect(shownReview.blocks![0]!.replyCount).toBe(1);
    expect(shownReview.blocks![1]!.replyCount ?? 0).toBe(0);
    // Nothing shown is listed top-level.
    const topIds = feed.entries.map((e) => e.id);
    for (const id of [r.id, f1.id, f2.id, comment.id]) {
      expect(topIds).not.toContain(id);
    }
    // The card's thread leaves the review out (the card draws it); the
    // review's leaves its findings out; the finding's thread is its comments.
    expect(
      (await svc.store.listThread(card.id))!.replies.map((b) => b.id)
    ).toEqual([]);
    expect(
      (await svc.store.listThread(r.id))!.replies.map((b) => b.id)
    ).toEqual([]);
    expect(
      (await svc.store.listThread(f1.id))!.replies.map((b) => b.id)
    ).toEqual([comment.id]);
  });

  it("keeps a comment on a finding in the finding's own thread, and sends an agent's to the other side", async () => {
    const { svc, injected } = build();
    const { f1 } = await reviewed(svc);
    injected.length = 0;
    const fromBuilder = await svc.post(A, {
      text: "Fixed in 3b2.",
      replyTo: f1.id,
    });
    expect(fromBuilder).toMatchObject({
      threadId: f1.id,
      replyTo: f1.id,
      toAgentId: B,
      data: null,
    });
    await settled(svc, fromBuilder.id);
    expect(injected.map((i) => i.agentId)).toEqual([B]);
    // The reviewer raised it: it is told to settle it.
    expect(injected[0]?.text).toContain('About the finding "a".');
    expect(injected[0]?.text).toContain(
      `You raised it: once the reply settles it, resolve it with update({ id: "${f1.id}", state: { status: "fixed" } })`
    );
    expect(injected[0]?.text).toContain(`replyTo: "${f1.id}"`);

    injected.length = 0;
    const fromReviewer = await svc.post(B, {
      text: "Still spins for me.",
      replyTo: f1.id,
    });
    expect(fromReviewer).toMatchObject({ threadId: f1.id, toAgentId: A });
    await settled(svc, fromReviewer.id);
    expect(injected.map((i) => i.agentId)).toEqual([A]);
    expect(injected[0]?.text).toContain(
      "Its reviewer resolves it; reply here with what you changed or why you disagree."
    );
    // A reply to a comment inside the finding's thread stays there.
    const nested = await svc.post(A, {
      text: "Try again now.",
      replyTo: fromReviewer.id,
    });
    expect(nested).toMatchObject({
      threadId: f1.id,
      replyTo: fromReviewer.id,
      toAgentId: B,
    });
    await settled(svc, nested.id);
  });

  it("sends a person's comment on a finding to both sides, and a reply to a comment to its author", async () => {
    const { svc, injected } = build();
    const { f1 } = await reviewed(svc);
    injected.length = 0;
    const both = await svc.sendUserPost(A, {
      text: "Please handle this first.",
      replyTo: f1.id,
    });
    expect(both.block).toMatchObject({
      threadId: f1.id,
      replyTo: f1.id,
      // The reviewer (the finding's author) first, then whose work it is.
      toAgentId: B,
      data: { recipients: [B, A] },
    });
    await settled(svc, both.block.id);
    expect(injected.map((i) => i.agentId).sort()).toEqual([A, B].sort());
    // Each recipient's outcome is recorded on its own, and read back as a
    // delivery per recipient, in the order the post went to them.
    const outcomes = await pool.query<{ deliveries: Record<string, boolean> }>(
      `SELECT deliveries FROM blocks WHERE id = $1`,
      [both.block.id]
    );
    expect(outcomes.rows[0]!.deliveries).toEqual({ [A]: true, [B]: true });
    expect((await svc.store.getById(both.block.id))!.delivery).toEqual([
      { agentId: B, state: "delivered" },
      { agentId: A, state: "delivered" },
    ]);

    // Answering the builder's comment goes to the builder alone.
    const builderSaid = await svc.post(A, { text: "Done.", replyTo: f1.id });
    await settled(svc, builderSaid.id);
    injected.length = 0;
    const answer = await svc.sendUserPost(A, {
      text: "Thanks.",
      replyTo: builderSaid.id,
    });
    expect(answer.block).toMatchObject({
      toAgentId: A,
      threadId: f1.id,
      replyTo: builderSaid.id,
      data: null,
    });
    await settled(svc, answer.block.id);
    expect(injected.map((i) => i.agentId)).toEqual([A]);
    expect(injected[0]?.text).toContain('About the finding "a".');
  });

  it("closes a question asked of an agent with that agent's reply, in the finding's thread", async () => {
    const { svc, injected } = build();
    const { f2 } = await reviewed(svc);
    // The reviewer asks the builder something under a finding.
    const q = await svc.post(B, {
      text: "Keep the hard cut, or return empty?",
      question: { options: [{ label: "Keep it" }, { label: "Return empty" }] },
      replyTo: f2.id,
    });
    expect(q).toMatchObject({
      kind: "question",
      toAgentId: A,
      threadId: f2.id,
      replyTo: f2.id,
    });
    await settled(svc, q.id);
    injected.length = 0;
    // The builder's reply answers it: an option's label closes it as that
    // option, and the envelope says so.
    const reply = await svc.post(A, { text: "Keep it", replyTo: q.id });
    expect(reply).toMatchObject({ toAgentId: B, threadId: f2.id });
    const answered = await svc.store.getById(q.id);
    expect(answered?.state).toMatchObject({
      answer: {
        value: "Keep it",
        label: "Keep it",
        by: { kind: "agent", agentId: A },
        blockId: reply.id,
      },
    });
    await settled(svc, reply.id);
    expect(injected[0]?.agentId).toBe(B);
    expect(injected[0]?.text).toContain(`This answers your question ${q.id}.`);
    // A second reply is just a reply.
    const more = await svc.post(A, { text: "Also…", replyTo: q.id });
    expect(
      (
        (await svc.store.getById(q.id))?.state as {
          answer?: { blockId?: string };
        } | null
      )?.answer?.blockId
    ).toBe(reply.id);
    expect(more.kind).toBe("text");
    // A reply by someone the question was not asked of answers nothing.
    const other = await svc.post(B, {
      text: "Return empty?",
      question: { options: [{ label: "Yes" }] },
      replyTo: f2.id,
    });
    await settled(svc, other.id);
    await svc.post(B, { text: "Yes", replyTo: other.id, to: A });
    expect(
      (
        (await svc.store.getById(other.id))?.state as {
          answer?: unknown;
        } | null
      )?.answer
    ).toBeUndefined();
  });

  it("puts a child's review on its card even when it names a replyTo; a root agent's review is top-level", async () => {
    const { svc } = build();
    const elsewhere = await svc.post(A, { text: "Some post." });
    const r = await svc.post(B, {
      to: A,
      replyTo: elsewhere.id,
      review: {
        summary: "s",
        findings: [{ severity: "major", title: "a", body: "b" }],
      },
    });
    expect(r).toMatchObject({
      threadId: launchBlockId(B),
      replyTo: launchBlockId(B),
      toAgentId: A,
    });
    await settled(svc, r.id);
    // A second review by the same child is shown after the first.
    const second = await svc.post(B, {
      to: A,
      review: { summary: "again", findings: [] },
    });
    expect((await svc.store.getById(launchBlockId(B)))!.state).toMatchObject({
      blocks: [r.id, second.id],
    });
    await settled(svc, second.id);
    // A's own review (A is a root agent) sits in its stream.
    const own = await svc.post(A, {
      review: {
        summary: "self",
        findings: [{ severity: "nit", title: "t", body: "b" }],
      },
    });
    expect(own).toMatchObject({
      threadId: null,
      replyTo: null,
      toAgentId: null,
    });
    // With nobody to deliver to, its findings are undelivered records.
    expect(own.blocks![0]).toMatchObject({ toAgentId: null, delivered: null });
  });

  it("writes a review and its findings together, or not at all", async () => {
    const { svc } = build();
    const before = await pool.query(`SELECT count(*)::int AS n FROM blocks`);
    await expect(
      svc.post(B, {
        to: A,
        review: {
          summary: "s",
          findings: [
            { severity: "major", title: "ok", body: "b" },
            { severity: "major", title: "x".repeat(301), body: "b" },
          ],
        },
      })
    ).rejects.toThrow(/finding 2 needs a title/);
    const after = await pool.query(
      `SELECT count(*)::int AS n FROM blocks WHERE kind IN ('review', 'finding')`
    );
    expect(after.rows[0].n).toBe(0);
    void before;
  });

  it("puts a child's own post in its launch thread, and delivers it only to whom it names", async () => {
    const { svc, injected } = build();
    const quiet = await svc.post(B, { text: "Starting the pass." });
    expect(quiet).toMatchObject({
      streamId: A,
      threadId: launchBlockId(B),
      replyTo: launchBlockId(B),
      toAgentId: null,
      delivered: null,
    });
    await svc.waitForInFlightDeliveries(1_000);
    expect(injected).toEqual([]);
    // Named with `to`, it still lands at home, delivered to that agent only.
    const told = await svc.post(B, { to: A, text: "Halfway there." });
    expect(told).toMatchObject({
      threadId: launchBlockId(B),
      toAgentId: A,
    });
    expect(told.data).toBeNull();
    await settled(svc, told.id);
    expect(injected.map((i) => i.agentId)).toEqual([A]);
    // A root agent's own post stays top-level.
    const root = await svc.post(A, { text: "Mine." });
    expect(root).toMatchObject({ threadId: null, replyTo: null });
    // A person's post to the child, outside any thread, goes to its card.
    injected.length = 0;
    const toChild = await svc.sendUserPost(A, { to: B, text: "How is it?" });
    expect(toChild.block).toMatchObject({
      streamId: A,
      toAgentId: B,
      threadId: launchBlockId(B),
      replyTo: launchBlockId(B),
    });
    await settled(svc, toChild.block.id);
    expect(injected.map((i) => i.agentId)).toEqual([B]);
    // The launch thread lists all of it, oldest first.
    expect(
      (await svc.store.listThread(launchBlockId(B)))!.replies.map((b) => b.id)
    ).toEqual([quiet.id, told.id, toChild.block.id]);
  });

  it("sends a command typed to a child raw, including after a failed delivery", async () => {
    const { svc: failing, injected: first } = build({
      fail: true,
      commands: ["skills"],
    });
    const posted = await failing.sendUserPost(A, {
      to: B,
      text: "/skills list",
    });
    const failed = await settled(failing, posted.block.id);
    expect(failed).toMatchObject({
      delivered: false,
      threadId: launchBlockId(B),
      replyTo: launchBlockId(B),
      data: { acpCommand: true },
    });
    expect(first).toEqual([{ agentId: B, text: "/skills list" }]);

    const { svc, injected, injectedOpts } = build();
    await svc.retryDelivery(A, failed.id);
    await settled(svc, failed.id);
    expect(injected).toEqual([{ agentId: B, text: "/skills list" }]);
    expect(injectedOpts[0]).toMatchObject({ blockId: failed.id, alone: true });
  });

  it("routes a reply on the launch card between the parent and the child", async () => {
    const { svc, injected } = build();
    const card = await launchChild(svc);
    expect(card.launchedByAgentId).toBe(A);
    const fromChild = await svc.post(B, {
      text: "Question?",
      replyTo: card.id,
    });
    // The card's sides are its launcher (A) and the child (B).
    expect(fromChild).toMatchObject({ threadId: card.id, toAgentId: A });
    await settled(svc, fromChild.id);
    injected.length = 0;
    const fromPerson = await svc.sendUserPost(A, {
      text: "Carry on.",
      replyTo: card.id,
    });
    expect(fromPerson.block).toMatchObject({
      threadId: card.id,
      data: { recipients: [A, B] },
    });
    await settled(svc, fromPerson.block.id);
    expect(injected.map((i) => i.agentId).sort()).toEqual([A, B].sort());
  });

  it("places turns: a child's opened by its card in its launch thread, a review's at home, a finding's and a finding comment's on the finding", async () => {
    const { svc } = build();
    const card = await svc.ensureLaunchBlock(B);
    const childTurn = await svc.recordTurnStarted({
      agentId: B,
      turnRow: turnRow(41, B),
      // The first turn is the card's briefing, delivered as a post.
      prompt: { source: "chat", text: "Review it", chatMessageId: card.id },
    });
    expect(await svc.store.getById(childTurn!)).toMatchObject({
      streamId: A,
      threadId: card.id,
      replyTo: card.id,
      origin: "turn",
    });
    const { r, f1 } = await reviewed(svc);
    // A (a root agent) opened by the review, a block the card shows: its
    // work goes in its own place, top-level.
    const parentTurn = await svc.recordTurnStarted({
      agentId: A,
      turnRow: turnRow(42, A),
      prompt: { source: "chat", text: "", chatMessageId: r.id },
    });
    expect(await svc.store.getById(parentTurn!)).toMatchObject({
      threadId: null,
      replyTo: null,
    });
    // Opened by a reopen notification, whose prompt names the finding:
    // answered under that finding, its own thread.
    const findingTurn = await svc.recordTurnStarted({
      agentId: A,
      turnRow: turnRow(43, A),
      prompt: {
        source: "chat",
        text: "",
        chatMessageId: f1.id,
        answerIn: f1.id,
      },
    });
    expect(await svc.store.getById(findingTurn!)).toMatchObject({
      threadId: f1.id,
      replyTo: f1.id,
    });
    // Opened by a comment under the finding: the answer goes there.
    const comment = await svc.post(B, { text: "Still wrong.", replyTo: f1.id });
    const onFinding = await svc.recordTurnStarted({
      agentId: A,
      turnRow: turnRow(44, A),
      prompt: { source: "chat", text: "", chatMessageId: comment.id },
    });
    expect(await svc.store.getById(onFinding!)).toMatchObject({
      threadId: f1.id,
      replyTo: comment.id,
      data: { turnEventId: 44 },
    });
    // The child's turn opened by the builder's answer on the finding stays
    // on the finding too.
    const answer = await svc.post(A, { text: "Fixed.", replyTo: comment.id });
    const reviewerTurn = await svc.recordTurnStarted({
      agentId: B,
      turnRow: turnRow(45, B),
      prompt: { source: "chat", text: "", chatMessageId: answer.id },
    });
    expect(await svc.store.getById(reviewerTurn!)).toMatchObject({
      threadId: f1.id,
      replyTo: answer.id,
    });
    await svc.waitForInFlightDeliveries(1_000);
  });

  it("tells the builder only when the reviewer reopens a finding, and the reviewer when the builder resolves one", async () => {
    const { svc, injected, injectedOpts } = build();
    const { f1, f2 } = await reviewed(svc);
    injected.length = 0;
    // The reviewer resolving its own finding: nothing asked of the builder.
    await svc.update(B, f1.id, {
      state: { status: "fixed", note: "Verified." },
    });
    await svc.waitForInFlightDeliveries(1_000);
    expect(injected).toEqual([]);
    // Reopening it is the builder's move: the builder is told, on the finding.
    await svc.update(B, f1.id, {
      state: { status: "open", note: "Regressed." },
    });
    await svc.waitForInFlightDeliveries(1_000);
    expect(injected.map((i) => i.agentId)).toEqual([A]);
    expect(injected[0]!.text).toContain(
      `--- DISPATCH POST (id: ${f1.id}, from: Peer (${B})) ---\nFinding "a" reopened: Regressed.`
    );
    expect(injected[0]!.text).toContain(`In the thread under ${f1.id}.`);
    // The notice says where its answer goes: under the finding.
    expect(injectedOpts[injectedOpts.length - 1]).toMatchObject({
      source: { source: "chat", chatMessageId: f1.id, answerIn: f1.id },
    });
    injected.length = 0;
    await svc.update(A, f2.id, {
      state: { status: "dismissed", note: "Out of scope." },
    });
    await svc.waitForInFlightDeliveries(1_000);
    expect(injected.map((i) => i.agentId)).toEqual([B]);
    expect(injected[0]!.text).toContain('Finding "c" dismissed: Out of scope.');
    expect(injected[0]!.text).toContain(`replyTo: "${f2.id}"`);
  });

  it("marks a finding's comments read on their own, apart from the rest", async () => {
    const { svc } = build();
    const { r, f1, f2 } = await reviewed(svc);
    const c1 = await svc.post(A, { text: "one", replyTo: f1.id });
    const c2 = await svc.post(B, { text: "two", replyTo: f2.id });
    await svc.sendUserPost(A, { text: "mine", replyTo: f1.id });
    const first = await svc.store.markThreadRead(A, f1.id);
    expect(first.ids).toEqual([c1.id]);
    expect(first.readAt).toEqual(expect.any(String));
    expect((await svc.store.markThreadRead(A, f2.id)).ids).toEqual([c2.id]);
    expect(await svc.store.markThreadRead(A, f1.id)).toEqual({
      ids: [],
      readAt: null,
    });
    // Another stream's mark touches nothing here.
    expect(await svc.store.markThreadRead(B, r.id)).toEqual({
      ids: [],
      readAt: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

describe("StreamService reactions", () => {
  /** The reactions on the block's feed row, as the last event carried them. */
  function lastEntryReactions(events: unknown[]): unknown {
    const last = events[events.length - 1] as {
      type: string;
      entry: { block: Block };
    };
    expect(last.type).toBe("stream.entry");
    return last.entry.block.reactions;
  }

  async function agentPost(text = "Shipped it."): Promise<Block> {
    return service.post(A, { text });
  }

  it("stores a pending reaction, injects a reaction envelope, then settles delivered", async () => {
    const block = await agentPost("Shipped the fix.");
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { svc, events, injected } = build({ gate });

    const res = await svc.addReaction(A, block.id, "👍");
    expect(res).toEqual({
      blockId: block.id,
      reactions: [
        {
          id: expect.any(String),
          author: { kind: "user" },
          emoji: "👍",
          delivered: null,
          createdAt: expect.any(String),
        },
      ],
    });
    expect(injected).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(lastEntryReactions(events)).toEqual(res.reactions);

    release();
    await svc.waitForInFlightDeliveries(1_000);
    expect(injected).toEqual([
      {
        agentId: A,
        text: expect.stringContaining(
          `--- DISPATCH REACTION (block id: ${block.id}) ---\nThe user reacted 👍 to your latest post:\n> Shipped the fix.\n`
        ),
      },
    ]);
    expect(await svc.store.listReactions(block.id)).toEqual([
      expect.objectContaining({ emoji: "👍", delivered: true }),
    ]);
    expect(events).toHaveLength(2);
    expect(lastEntryReactions(events)).toEqual([
      expect.objectContaining({ emoji: "👍", delivered: true }),
    ]);
  });

  it("adding an emoji the block already carries delivers nothing again", async () => {
    const block = await agentPost();
    const { svc, events, injected } = build();
    await svc.addReaction(A, block.id, "🎉");
    await svc.waitForInFlightDeliveries(1_000);
    events.length = 0;
    const again = await svc.addReaction(A, block.id, " 🎉 ");
    await svc.waitForInFlightDeliveries(1_000);
    expect(again.reactions).toHaveLength(1);
    expect(injected).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it("keeps several emoji on one block in the order they were added", async () => {
    const block = await agentPost();
    const { svc } = build();
    await svc.addReaction(A, block.id, "👍");
    await svc.addReaction(A, block.id, "🚀");
    await svc.waitForInFlightDeliveries(1_000);
    expect(
      (await svc.store.listReactions(block.id)).map((r) => r.emoji)
    ).toEqual(["👍", "🚀"]);
  });

  it("records delivered=false when the inject fails, and when there is no engine", async () => {
    const block = await agentPost();
    const failing = build({ fail: true });
    await failing.svc.addReaction(A, block.id, "👀");
    await failing.svc.waitForInFlightDeliveries(1_000);
    const inertSvc = build({ access: inert });
    const res = await inertSvc.svc.addReaction(A, block.id, "✅");
    expect(inertSvc.injected).toEqual([]);
    expect(res.reactions).toEqual([
      expect.objectContaining({ emoji: "👀", delivered: false }),
      expect.objectContaining({ emoji: "✅", delivered: false }),
    ]);
  });

  it("removes a reaction without injecting anything", async () => {
    const block = await agentPost();
    const { svc, events, injected } = build();
    await svc.addReaction(A, block.id, "👍");
    await svc.waitForInFlightDeliveries(1_000);
    events.length = 0;
    const res = await svc.removeReaction(A, block.id, "👍");
    expect(res).toEqual({ blockId: block.id, reactions: [] });
    expect(injected).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(lastEntryReactions(events)).toBeUndefined();
    events.length = 0;
    await svc.removeReaction(A, block.id, "👍");
    expect(events).toEqual([]);
  });

  it("only takes reactions on other people's blocks on this stream, with a real emoji", async () => {
    const { svc, injected } = build();
    const userPost = await svc.sendUserPost(A, { text: "hi" });
    const block = await agentPost();
    const elsewhere = await service.post(B, { text: "x" });
    await expect(
      svc.addReaction(A, userPost.block.id, "👍")
    ).rejects.toBeInstanceOf(StreamNotFoundError);
    await expect(svc.addReaction(A, elsewhere.id, "👍")).rejects.toBeInstanceOf(
      StreamNotFoundError
    );
    await expect(svc.addReaction(A, "not-a-uuid", "👍")).rejects.toThrow(
      /blockId must be a UUID/
    );
    await expect(svc.addReaction(A, block.id, "lgtm")).rejects.toThrow(
      /single emoji/
    );
    await expect(
      svc.removeReaction(A, elsewhere.id, "👍")
    ).rejects.toBeInstanceOf(StreamNotFoundError);
    await svc.waitForInFlightDeliveries(1_000);
    expect(injected).toHaveLength(1);
  });

  it("caps the reactions on one block", async () => {
    const block = await agentPost();
    const { svc } = build({ access: inert });
    const emoji = [..."😀😁😂🤣😃😄😅😆😉😊😋😎😍😘🥰😗😙🥲😚🙂"];
    for (const e of emoji) await svc.addReaction(A, block.id, e);
    await expect(svc.addReaction(A, block.id, "🤗")).rejects.toThrow(
      /20 reactions at most/
    );
  });

  it("recovery marks a reaction abandoned by a restart as not delivered", async () => {
    const block = await agentPost();
    const { svc, events } = build({ gate: new Promise<void>(() => {}) });
    await svc.addReaction(A, block.id, "👍");
    events.length = 0;
    expect(await svc.recoverPendingDeliveries()).toEqual([A]);
    expect(await svc.store.listReactions(block.id)).toEqual([
      expect.objectContaining({ delivered: false }),
    ]);
    expect(events).toEqual([{ type: "stream.changed", agentId: A }]);
  });

  it("counts how many posts back an older block is, ignoring the user's posts and replies", async () => {
    const first = await agentPost("First take.");
    const { svc, injected } = build();
    await svc.sendUserPost(A, { text: "hmm" });
    await agentPost("Second take.");
    await service.post(A, { text: "in thread", replyTo: first.id });
    await agentPost("Third take.");
    await svc.waitForInFlightDeliveries(1_000);
    injected.length = 0;
    await svc.addReaction(A, first.id, "🤔");
    await svc.waitForInFlightDeliveries(1_000);
    expect(injected[0]?.text).toContain(
      "The user reacted 🤔 to your post from 2 posts ago:\n> First take."
    );
  });

  it("lets an agent react to the user's and other agents' blocks, shown but never injected", async () => {
    const { svc, events, injected } = build();
    const userPost = await svc.sendUserPost(A, {
      text: "Can you check the logs?",
    });
    const peer = await svc.post(B, { to: A, text: "FYI" });
    await svc.waitForInFlightDeliveries(1_000);
    injected.length = 0;
    events.length = 0;
    const res = await svc.addReaction(A, userPost.block.id, "👀", {
      kind: "agent",
      agentId: A,
    });
    await svc.waitForInFlightDeliveries(1_000);
    expect(res.reactions).toEqual([
      {
        id: expect.any(String),
        author: { kind: "agent", agentId: A },
        emoji: "👀",
        delivered: null,
        createdAt: expect.any(String),
      },
    ]);
    expect(injected).toEqual([]);
    expect(events).toHaveLength(1);
    expect(lastEntryReactions(events)).toEqual(res.reactions);
    // Another agent's block on the stream (a review it received) takes one too.
    // The reacting agent's stream is its own: the peer's block lives on B's.
    await expect(
      svc.addReaction(A, peer.id, "👍", { kind: "agent", agentId: A })
    ).rejects.toBeInstanceOf(StreamNotFoundError);
    expect(
      (await svc.addReaction(B, peer.id, "👍", { kind: "agent", agentId: A }))
        .reactions
    ).toHaveLength(1);
    // A restart's sweep leaves agent reactions alone: they had nothing to deliver.
    expect(await svc.recoverPendingDeliveries()).toEqual([]);
    expect(
      (await svc.store.listReactions(userPost.block.id))[0]?.delivered
    ).toBeNull();
    const removed = await svc.removeReaction(A, userPost.block.id, "👀", {
      kind: "agent",
      agentId: A,
    });
    expect(removed.reactions).toEqual([]);
  });

  it("keeps each side to the other's blocks, and each author's reactions its own", async () => {
    const { svc } = build({ access: inert });
    const agentBlock = await agentPost();
    const userPost = await svc.sendUserPost(A, { text: "hi" });
    await expect(
      svc.addReaction(A, agentBlock.id, "👍", { kind: "agent", agentId: A })
    ).rejects.toThrow(/DISPATCH POST envelope/);
    await expect(
      svc.addReaction(A, userPost.block.id, "👍", { kind: "user" })
    ).rejects.toBeInstanceOf(StreamNotFoundError);
    await expect(
      svc.addReaction(A, "nope", "👍", { kind: "agent", agentId: A })
    ).rejects.toThrow(/id must be the block id from a DISPATCH POST envelope/);
    await svc.addReaction(A, agentBlock.id, "👍", { kind: "user" });
    // The agent cannot take the user's reaction back off.
    await svc.removeReaction(A, userPost.block.id, "👍", {
      kind: "agent",
      agentId: A,
    });
    expect(await svc.store.listReactions(agentBlock.id)).toEqual([
      expect.objectContaining({ author: { kind: "user" }, emoji: "👍" }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Recovery, shutdown, events
// ---------------------------------------------------------------------------

describe("StreamService delivery bookkeeping", () => {
  it("recoverPendingDeliveries sweeps pending addressed blocks and announces each stream", async () => {
    const { svc, events } = build();
    const pending = await svc.store.insert({
      streamId: A,
      author: { kind: "user" },
      toAgentId: A,
      text: "stuck",
      delivered: null,
    });
    const other = await svc.store.insert({
      streamId: B,
      author: { kind: "agent", agentId: A },
      toAgentId: B,
      text: "stuck too",
      delivered: null,
    });
    const fine = await svc.store.insert({
      streamId: A,
      author: { kind: "user" },
      toAgentId: A,
      text: "ok",
      delivered: true,
    });
    const touched = await svc.recoverPendingDeliveries();
    expect(touched.sort()).toEqual([A, B].sort());
    expect((await svc.store.getById(pending.id))?.delivered).toBe(false);
    expect((await svc.store.getById(other.id))?.delivered).toBe(false);
    expect((await svc.store.getById(fine.id))?.delivered).toBe(true);
    expect(events).toEqual(
      expect.arrayContaining([
        { type: "stream.changed", agentId: A },
        { type: "stream.changed", agentId: B },
      ])
    );
    expect(events).toHaveLength(2);
    events.length = 0;
    expect(await svc.recoverPendingDeliveries()).toEqual([]);
    expect(events).toEqual([]);
  });

  it("waitForInFlightDeliveries resolves at once with nothing in flight and times out otherwise", async () => {
    const { svc } = build({ gate: new Promise<void>(() => {}) });
    expect(await svc.waitForInFlightDeliveries(5)).toBe(true);
    await svc.sendUserPost(A, { text: "never lands" });
    const started = Date.now();
    expect(await svc.waitForInFlightDeliveries(30)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(svc.inFlightDeliveryCount).toBe(1);
  });

  it("refuses to deliver without an adapter, but still posts for people", async () => {
    await expect(service.sendUserPost(A, { text: "x" })).rejects.toThrow(
      /no delivery adapter/
    );
    await expect(service.post(A, { to: B, text: "x" })).rejects.toThrow(
      /no delivery adapter/
    );
    await expect(service.post(A, { text: "fine" })).resolves.toMatchObject({
      text: "fine",
    });
  });

  it("publishes stream.changed and stream.read on demand", () => {
    const { svc, events } = build();
    svc.publishChanged(A);
    svc.publishRead(A, {
      unreadCount: 2,
      readAt: "2026-01-01T00:00:00.000Z",
      upToAt: null,
    });
    expect(events).toEqual([
      { type: "stream.changed", agentId: A },
      {
        type: "stream.read",
        agentId: A,
        unreadCount: 2,
        readAt: "2026-01-01T00:00:00.000Z",
        upToAt: null,
      },
    ]);
  });

  it("publishTurnEntry stays quiet with no listener or no turn", async () => {
    const { svc, events } = build({ deps: { hasUiClient: () => false } });
    await svc.publishTurnEntry(A);
    expect(events).toEqual([]);
    const listening = build({ deps: { hasUiClient: () => true } });
    await listening.svc.publishTurnEntry(A);
    expect(listening.events).toEqual([]);
  });
});

describe("StreamService turn blocks", () => {
  const turnRow = (id: number, prompt: Record<string, unknown>) => ({
    id,
    agentId: A,
    seq: id,
    kind: "turn" as const,
    key: null,
    payload: { state: "started", prompt },
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  it("opens an empty block by the agent when a turn starts, and fills it with the answer on settle", async () => {
    const row = await pool.query<{ id: string }>(
      `INSERT INTO agent_stream_events (agent_id, seq, kind, payload)
       VALUES ($1, 1, 'turn', '{"state":"started","prompt":{"source":"chat","text":"go"}}') RETURNING id`,
      [A]
    );
    const eventId = Number(row.rows[0]!.id);
    const blockId = await service.recordTurnStarted({
      agentId: A,
      turnRow: turnRow(eventId, { source: "chat", text: "go" }),
      prompt: { source: "chat", text: "go" },
    });
    expect(blockId).toBeTruthy();
    const opened = await service.store.getById(blockId!);
    expect(opened).toMatchObject({
      author: { kind: "agent", agentId: A },
      kind: "text",
      origin: "turn",
      data: { turnEventId: eventId },
      text: "",
      threadId: null,
      toAgentId: null,
    });
    await pool.query(
      `INSERT INTO agent_stream_events (agent_id, seq, kind, payload)
       VALUES ($1, 2, 'assistant', '{"text":"All done.","streaming":false}')`,
      [A]
    );
    await pool.query(
      `UPDATE agent_stream_events SET payload = payload || $2::jsonb WHERE id = $1`,
      [eventId, JSON.stringify({ state: "settled", blockId })]
    );
    published.length = 0;
    await service.recordTurnSettled({
      agentId: A,
      turnRow: {
        ...turnRow(eventId, { source: "chat", text: "go" }),
        payload: {
          state: "settled",
          blockId,
          prompt: { source: "chat", text: "go" },
        },
      },
    });
    const settled = await service.store.getById(blockId!);
    expect(settled?.text).toBe("All done.");
    // The row goes out with its turn attached, then a refetch nudge.
    expect(published[0]).toMatchObject({
      type: "stream.entry",
      agentId: A,
      entry: {
        type: "block",
        id: blockId,
        block: {
          text: "All done.",
          turn: { settled: true, result: { text: "All done." } },
        },
      },
    });
    expect(published[1]).toEqual({ type: "stream.changed", agentId: A });
  });

  it("a settle during a turn compose in flight is published last, as the settled row", async () => {
    const row = await pool.query<{ id: string }>(
      `INSERT INTO agent_stream_events (agent_id, seq, kind, payload)
       VALUES ($1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM agent_stream_events WHERE agent_id = $1),
               'turn', '{"state":"started","prompt":{"source":"chat","text":"go"}}') RETURNING id`,
      [A]
    );
    const eventId = Number(row.rows[0]!.id);
    const blockId = await service.recordTurnStarted({
      agentId: A,
      turnRow: turnRow(eventId, { source: "chat", text: "go" }),
      prompt: { source: "chat", text: "go" },
    });
    await pool.query(
      `UPDATE agent_stream_events SET payload = payload || $2::jsonb WHERE id = $1`,
      [eventId, JSON.stringify({ blockId })]
    );
    published.length = 0;
    // A step's compose is under way when the turn settles; the settle's own
    // publish and a trailing compose follow it.
    const inFlight = service.publishTurnEntry(A);
    await pool.query(
      `INSERT INTO agent_stream_events (agent_id, seq, kind, payload)
       VALUES ($1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM agent_stream_events WHERE agent_id = $1),
               'assistant', '{"text":"All done.","streaming":false}')`,
      [A]
    );
    await pool.query(
      `UPDATE agent_stream_events SET payload = payload || $2::jsonb WHERE id = $1`,
      [eventId, JSON.stringify({ state: "settled" })]
    );
    const trailing = service.publishTurnEntry(A);
    await service.recordTurnSettled({
      agentId: A,
      turnRow: {
        ...turnRow(eventId, { source: "chat", text: "go" }),
        payload: {
          state: "settled",
          blockId,
          prompt: { source: "chat", text: "go" },
        },
      },
    });
    await Promise.all([inFlight, trailing]);
    const entries = published.filter(
      (
        event
      ): event is {
        type: "stream.entry";
        entry: { id: string; block: Block };
      } => (event as { type: string }).type === "stream.entry"
    );
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.at(-1)!.entry).toMatchObject({
      id: blockId,
      block: { text: "All done.", turn: { settled: true } },
    });
  });

  it("a turn a thread reply opened answers in that thread", async () => {
    const root = await service.store.insert({
      streamId: A,
      author: { kind: "agent", agentId: A },
      text: "root",
    });
    const reply = await service.store.insert({
      streamId: A,
      author: { kind: "user" },
      toAgentId: A,
      threadId: root.id,
      replyTo: root.id,
      text: "and then?",
      delivered: true,
    });
    const blockId = await service.recordTurnStarted({
      agentId: A,
      turnRow: turnRow(7, { source: "chat", chatMessageId: reply.id }),
      prompt: { source: "chat", text: "and then?", chatMessageId: reply.id },
    });
    expect(await service.store.getById(blockId!)).toMatchObject({
      threadId: root.id,
      replyTo: reply.id,
      origin: "turn",
    });
  });

  it("a turn opened by a comment on a finding answers on that finding, one whose prompt names the finding on it, and one opened by a shown block goes home", async () => {
    const review = await service.store.insert({
      streamId: A,
      author: { kind: "agent", agentId: B },
      toAgentId: A,
      kind: "review",
      text: "",
      data: { summary: "One thing." },
      state: { blocks: [] },
    });
    const finding = await service.store.insert({
      streamId: A,
      author: { kind: "agent", agentId: B },
      toAgentId: A,
      kind: "finding",
      threadId: review.id,
      replyTo: review.id,
      data: { severity: "major", title: "Null", body: "Guard." },
      state: { status: "open", by: { kind: "agent", agentId: B }, at: "t" },
      delivered: true,
    });
    await service.store.appendShown(review.id, finding.id);
    const comment = await service.store.insert({
      streamId: A,
      author: { kind: "user" },
      toAgentId: A,
      threadId: finding.id,
      replyTo: finding.id,
      text: "fix it?",
      delivered: true,
    });
    const blockId = await service.recordTurnStarted({
      agentId: A,
      turnRow: turnRow(8, { source: "chat", chatMessageId: comment.id }),
      prompt: { source: "chat", text: "fix it?", chatMessageId: comment.id },
    });
    expect(await service.store.getById(blockId!)).toMatchObject({
      threadId: finding.id,
      replyTo: comment.id,
      data: { turnEventId: 8 },
    });
    // The review is shown, not a reply: a turn it opens is work, and goes
    // to the agent's own place.
    const fromReview = await service.recordTurnStarted({
      agentId: A,
      turnRow: turnRow(9, { source: "chat", chatMessageId: review.id }),
      prompt: { source: "chat", text: "", chatMessageId: review.id },
    });
    expect(await service.store.getById(fromReview!)).toMatchObject({
      threadId: null,
      replyTo: null,
    });
    // A shown block on its own opens work, whatever its kind: the prompt
    // itself says when its answer belongs under the block (a reopen).
    const fromFinding = await service.recordTurnStarted({
      agentId: A,
      turnRow: turnRow(10, { source: "chat", chatMessageId: finding.id }),
      prompt: { source: "chat", text: "", chatMessageId: finding.id },
    });
    expect(await service.store.getById(fromFinding!)).toMatchObject({
      threadId: null,
      replyTo: null,
    });
    const reopened = await service.recordTurnStarted({
      agentId: A,
      turnRow: turnRow(11, { source: "chat", chatMessageId: finding.id }),
      prompt: {
        source: "chat",
        text: "",
        chatMessageId: finding.id,
        answerIn: finding.id,
      },
    });
    expect(await service.store.getById(reopened!)).toMatchObject({
      threadId: finding.id,
      replyTo: finding.id,
    });
  });

  it("posts delivered together answer in their thread only when they share one", async () => {
    const root = await service.store.insert({
      streamId: A,
      author: { kind: "agent", agentId: A },
      text: "root",
    });
    const inThread = async (text: string) =>
      service.store.insert({
        streamId: A,
        author: { kind: "user" },
        toAgentId: A,
        threadId: root.id,
        replyTo: root.id,
        text,
        delivered: true,
      });
    const one = await inThread("one");
    const two = await inThread("two");
    const both = await service.recordTurnStarted({
      agentId: A,
      turnRow: turnRow(21, { source: "chat", chatMessageId: one.id }),
      prompt: {
        source: "chat",
        chatMessageId: one.id,
        chatMessageIds: [one.id, two.id],
      },
    });
    expect(await service.store.getById(both!)).toMatchObject({
      threadId: root.id,
      replyTo: two.id,
    });

    const top = await service.store.insert({
      streamId: A,
      author: { kind: "user" },
      toAgentId: A,
      text: "in the channel",
      delivered: true,
    });
    const mixed = await service.recordTurnStarted({
      agentId: A,
      turnRow: turnRow(22, { source: "chat", chatMessageId: one.id }),
      prompt: {
        source: "chat",
        chatMessageId: one.id,
        chatMessageIds: [one.id, top.id],
      },
    });
    expect(await service.store.getById(mixed!)).toMatchObject({
      threadId: null,
      replyTo: null,
    });
  });

  it("an interrupting post is delivered to go alone", async () => {
    const { svc, injectedOpts, cancelled } = build();
    const plain = await svc.sendUserPost(A, { text: "a note" });
    const cut = await svc.sendUserPost(A, { text: "stop", interrupt: true });
    await svc.waitForInFlightDeliveries(1_000);
    expect(cancelled).toEqual([A]);
    expect(injectedOpts).toEqual([
      { blockId: plain.block.id },
      { blockId: cut.block.id, alone: true },
    ]);
  });

  it("a turn set off by answering a question lands in the channel, not the question's thread", async () => {
    // An agent's question is usually a reply inside some other thread, so
    // the thread's root is not the question: what the answer replies to is.
    const opener = await service.store.insert({
      streamId: A,
      author: { kind: "user" },
      toAgentId: A,
      text: "have a look",
      delivered: true,
    });
    const question = await service.store.insert({
      streamId: A,
      author: { kind: "agent", agentId: A },
      kind: "question",
      text: "Which one?",
      threadId: opener.id,
      replyTo: opener.id,
      data: { options: [{ label: "This" }, { label: "That" }] },
      state: {},
    });
    const answer = await service.store.insert({
      streamId: A,
      author: { kind: "user" },
      toAgentId: A,
      threadId: question.threadId ?? question.id,
      replyTo: question.id,
      text: "This",
      delivered: true,
    });
    const blockId = await service.recordTurnStarted({
      agentId: A,
      turnRow: turnRow(11, { source: "chat", chatMessageId: answer.id }),
      prompt: { source: "chat", text: "This", chatMessageId: answer.id },
    });
    expect(await service.store.getById(blockId!)).toMatchObject({
      threadId: null,
      replyTo: null,
      origin: "turn",
    });
  });

  it("a turn set off by a reply to an ordinary post stays in that thread", async () => {
    const root = await service.store.insert({
      streamId: A,
      author: { kind: "agent", agentId: A },
      text: "Here is what I found.",
    });
    const reply = await service.store.insert({
      streamId: A,
      author: { kind: "user" },
      toAgentId: A,
      threadId: root.id,
      replyTo: root.id,
      text: "say more",
      delivered: true,
    });
    const blockId = await service.recordTurnStarted({
      agentId: A,
      turnRow: turnRow(12, { source: "chat", chatMessageId: reply.id }),
      prompt: { source: "chat", text: "say more", chatMessageId: reply.id },
    });
    expect(await service.store.getById(blockId!)).toMatchObject({
      threadId: root.id,
      replyTo: reply.id,
    });
  });

  it("settling a turn with no block behind it is a no-op", async () => {
    published.length = 0;
    await service.recordTurnSettled({
      agentId: A,
      turnRow: turnRow(99, { source: "chat", text: "x" }),
    });
    expect(published).toEqual([]);
  });
});

describe("StreamService @mentions", () => {
  it("delivers a post to every agent named with @, first named first, and records it on the block", async () => {
    await pool.query(
      `INSERT INTO agents (id, name, cwd, status, parent_agent_id)
       VALUES ('agt_m_kid1', 'reviewer', '/tmp', 'running', $1),
              ('agt_m_kid2', 'builder', '/tmp', 'running', $1)
       ON CONFLICT (id) DO UPDATE SET parent_agent_id = EXCLUDED.parent_agent_id, deleted_at = NULL`,
      [A]
    );
    AGENTS["agt_m_kid1"] = {
      id: "agt_m_kid1",
      name: "reviewer",
      filesDir: null,
      status: "running",
    };
    AGENTS["agt_m_kid2"] = {
      id: "agt_m_kid2",
      name: "builder",
      filesDir: null,
      status: "running",
    };
    const { svc, injected } = build({ withDelivery: true });
    const res = await svc.sendUserPost(A, {
      text: "@builder take the front end, @reviewer check it after",
    });
    expect(res.block).toMatchObject({
      toAgentId: "agt_m_kid2",
      data: { mentions: ["agt_m_kid2", "agt_m_kid1"] },
    });
    await settled(svc, res.block.id);
    expect(injected.map((i) => i.agentId).sort()).toEqual([
      "agt_m_kid1",
      "agt_m_kid2",
    ]);
    const toBuilder = injected.find((i) => i.agentId === "agt_m_kid2")!.text;
    expect(toBuilder).toContain(
      "Addressed to you by @mention, and also to reviewer."
    );
    expect(await svc.store.getById(res.block.id)).toMatchObject({
      delivered: true,
    });
  });

  it("a mention wins over the page's default recipient and a thread's other side", async () => {
    const { svc, injected } = build({ withDelivery: true });
    const res = await svc.sendUserPost(A, {
      to: "agt_m_kid2",
      text: "@reviewer only you",
    });
    expect(res.block.toAgentId).toBe("agt_m_kid1");
    await settled(svc, res.block.id);
    expect(injected.map((i) => i.agentId)).toEqual(["agt_m_kid1"]);
    expect(injected[0]!.text).toContain("Addressed to you by @mention.");
  });

  it("a name outside the tree is just text", async () => {
    const { svc } = build({ withDelivery: true });
    const res = await svc.sendUserPost(A, {
      text: "@Peer is not in this tree",
    });
    expect(res.block.toAgentId).toBe(A);
    expect(
      res.block.kind === "text" && res.block.data?.mentions
    ).toBeUndefined();
  });
});

describe("StreamService delivery that is never taken", () => {
  const never = new Promise<void>(() => {});

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up on a prompt an idle engine never takes, so the post can be retried", async () => {
    vi.useFakeTimers();
    const { svc } = build({ gate: never, held: false });
    const res = await svc.sendUserPost(A, { text: "are you there?" });
    expect(res.block.delivered).toBeNull();
    // Nothing has taken it, and the agent is not busy: past the bound it
    // reads as undelivered rather than sending forever.
    await vi.advanceTimersByTimeAsync(95_000);
    // The give-up writes to the database, which is real work the timer
    // flush does not wait for.
    vi.useRealTimers();
    let row = await svc.store.getById(res.block.id);
    for (let i = 0; i < 50 && row?.delivered === null; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      row = await svc.store.getById(res.block.id);
    }
    expect(row).toMatchObject({ delivered: false });
  });

  it("keeps waiting while the agent is busy, however long that takes", async () => {
    vi.useFakeTimers();
    const { svc } = build({ gate: never, held: true });
    const res = await svc.sendUserPost(A, { text: "after you finish" });
    // Queued behind the agent's own work is the queue doing its job.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await svc.store.getById(res.block.id)).toMatchObject({
      delivered: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Retrying a post the agent never took
// ---------------------------------------------------------------------------

describe("StreamService.retryDelivery", () => {
  it("retries a failed ACP command as the same raw, isolated prompt", async () => {
    const { svc: failing, injected: first } = build({
      fail: true,
      commands: ["compact"],
    });
    const posted = await failing.sendUserPost(A, { text: "/compact" });
    const failed = await settled(failing, posted.block.id);
    expect(failed.delivered).toBe(false);
    expect(first).toEqual([{ agentId: A, text: "/compact" }]);

    // A restarted runtime may not have rediscovered commands yet.
    const { svc, injected, injectedOpts } = build();
    await svc.retryDelivery(A, failed.id);
    await settled(svc, failed.id);
    expect(injected).toEqual([{ agentId: A, text: "/compact" }]);
    expect(injectedOpts[0]).toMatchObject({
      blockId: failed.id,
      alone: true,
    });
  });

  /** A post whose delivery failed: the row the Retry button acts on. */
  async function undelivered(text: string, to?: string) {
    const { svc } = build({ fail: true });
    const res = await svc.sendUserPost(A, {
      text,
      ...(to ? { to } : {}),
    });
    const block = await settled(svc, res.block.id);
    expect(block.delivered).toBe(false);
    return block;
  }

  it("sends the same block again and marks it delivered, with no second post", async () => {
    const failed = await undelivered("did you get this?");
    const before = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM blocks WHERE stream_id = $1`,
      [A]
    );
    const { svc, injected, events } = build();
    const { block } = await svc.retryDelivery(A, failed.id);
    // Pending the moment it is pressed, so the row stops saying "not
    // delivered" while the prompt is on its way.
    expect(block.delivered).toBeNull();
    expect(
      events.some((e) => (e as { type: string }).type === "stream.entry")
    ).toBe(true);
    const after = await settled(svc, failed.id);
    expect(after.delivered).toBe(true);
    expect(injected).toEqual([
      { agentId: A, text: expect.stringContaining("did you get this?") },
    ]);
    const count = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM blocks WHERE stream_id = $1`,
      [A]
    );
    expect(count.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("says why when the agent cannot take a prompt, and leaves the row failed", async () => {
    const failed = await undelivered("still there?");
    const { svc, injected } = build({ access: inert });
    await expect(svc.retryDelivery(A, failed.id)).rejects.toThrow("No engine.");
    expect(injected).toEqual([]);
    expect(await svc.store.getById(failed.id)).toMatchObject({
      delivered: false,
    });
  });

  it("refuses a post that already landed", async () => {
    const { svc } = build();
    const res = await svc.sendUserPost(A, { text: "landed" });
    await settled(svc, res.block.id);
    await expect(svc.retryDelivery(A, res.block.id)).rejects.toBeInstanceOf(
      StreamConflictError
    );
  });

  it("rebuilds the answer envelope, so the agent still learns what it answers", async () => {
    const asked = await service.post(A, {
      text: "Ship it?",
      question: { options: [{ label: "Yes", value: "yes" }, { label: "No" }] },
    });
    const { svc: failing } = build({ fail: true });
    const answered = await failing.answerQuestion(A, asked.id, {
      value: "yes",
    });
    const reply = await settled(failing, answered.reply.id);
    expect(reply.delivered).toBe(false);

    const { svc, injected } = build();
    await svc.retryDelivery(A, reply.id);
    await settled(svc, reply.id);
    expect(injected).toHaveLength(1);
    expect(injected[0]!.text).toContain(
      `This answers your question ${asked.id}.`
    );
  });

  it("does not claim a plain comment in a question's thread is the answer", async () => {
    const asked = await service.post(A, {
      text: "Which one?",
      question: { options: [{ label: "Left" }, { label: "Right" }] },
    });
    const { svc: failing } = build({ fail: true });
    const comment = await failing.sendUserPost(A, {
      text: "thinking about it",
      replyTo: asked.id,
    });
    const failed = await settled(failing, comment.block.id);
    expect(failed.delivered).toBe(false);

    const { svc, injected } = build();
    await svc.retryDelivery(A, failed.id);
    await settled(svc, failed.id);
    expect(injected[0]!.text).not.toContain("This answers your");
    expect(injected[0]!.text).toContain(`In the thread under ${asked.id}.`);
  });

  it("sends a multi-mention post to everyone it named, each told who else has it", async () => {
    const { svc: failing } = build({ fail: true });
    const res = await failing.sendUserPost(A, {
      text: "@builder and @reviewer, together please",
    });
    const failed = await settled(failing, res.block.id);
    expect(failed.delivered).toBe(false);

    const { svc, injected } = build();
    await svc.retryDelivery(A, failed.id);
    await settled(svc, failed.id);
    expect(injected.map((i) => i.agentId).sort()).toEqual([
      "agt_m_kid1",
      "agt_m_kid2",
    ]);
    const toBuilder = injected.find((i) => i.agentId === "agt_m_kid2")!.text;
    expect(toBuilder).toContain(
      "Addressed to you by @mention, and also to reviewer."
    );
  });

  it("carries the attachments again, described for the recipient", async () => {
    const fileId = await seedFiles(A, "trace.log", 40);
    const { svc: failing } = build({ fail: true });
    const res = await failing.sendUserPost(A, {
      text: "here is the log",
      attachments: [{ type: "file", fileId }],
    });
    const failed = await settled(failing, res.block.id);

    const { svc, injected } = build();
    await svc.retryDelivery(A, failed.id);
    await settled(svc, failed.id);
    expect(injected[0]!.text).toContain("trace.log");
  });
});

// ---------------------------------------------------------------------------
// Where a post has got to, per recipient
// ---------------------------------------------------------------------------

describe("StreamService delivery state", () => {
  const never = new Promise<void>(() => {});

  // Two children of the stream's agent, so a post can name more than one.
  beforeEach(async () => {
    await pool.query(
      `INSERT INTO agents (id, name, cwd, status, parent_agent_id)
       VALUES ('agt_m_kid1', 'reviewer', '/tmp', 'running', $1),
              ('agt_m_kid2', 'builder', '/tmp', 'running', $1)
       ON CONFLICT (id) DO UPDATE SET parent_agent_id = EXCLUDED.parent_agent_id, deleted_at = NULL`,
      [A]
    );
    AGENTS["agt_m_kid1"] = {
      id: "agt_m_kid1",
      name: "reviewer",
      filesDir: null,
      status: "running",
    };
    AGENTS["agt_m_kid2"] = {
      id: "agt_m_kid2",
      name: "builder",
      filesDir: null,
      status: "running",
    };
  });

  it("reads a prompt waiting behind a turn as held, not merely pending", async () => {
    const { svc } = build({ gate: never, held: true });
    const res = await svc.sendUserPost(A, { text: "when you're free" });
    const feed = await svc.feed(A);
    const row = feed.entries.find((e) => e.block.id === res.block.id)!;
    expect(row.block.delivery).toEqual([{ agentId: A, state: "held" }]);
    // The stored row knows nothing of it: held is true only while the turn
    // runs, so it is worked out whenever the stream is read.
    expect((await svc.store.getById(res.block.id))!.delivered).toBeNull();
  });

  it("reads the same prompt as sending once the agent is free", async () => {
    const { svc } = build({ gate: never, held: false });
    const res = await svc.sendUserPost(A, { text: "when you're free" });
    const feed = await svc.feed(A);
    const row = feed.entries.find((e) => e.block.id === res.block.id)!;
    expect(row.block.delivery).toEqual([{ agentId: A, state: "pending" }]);
  });

  it("keeps each recipient's outcome when a post goes to several agents", async () => {
    const { svc } = build({ failFor: ["agt_m_kid1"] });
    const res = await svc.sendUserPost(A, {
      text: "@builder and @reviewer, please look",
    });
    await settled(svc, res.block.id);
    const block = await svc.store.getById(res.block.id);
    // One of them never took it, so the post as a whole did not land.
    expect(block!.delivered).toBe(false);
    expect(block!.delivery).toEqual([
      { agentId: "agt_m_kid2", state: "delivered" },
      { agentId: "agt_m_kid1", state: "failed" },
    ]);
  });

  it("sends a partly delivered post again only to the agent that missed it", async () => {
    const { svc: failing } = build({ failFor: ["agt_m_kid1"] });
    const res = await failing.sendUserPost(A, {
      text: "@builder and @reviewer, please look",
    });
    await settled(failing, res.block.id);

    const { svc, injected } = build();
    await svc.retryDelivery(A, res.block.id);
    await settled(svc, res.block.id);
    // The builder already read it; a second copy would read as the person
    // saying the same thing twice.
    expect(injected.map((i) => i.agentId)).toEqual(["agt_m_kid1"]);
    const block = await svc.store.getById(res.block.id);
    expect(block!.delivered).toBe(true);
    expect(block!.delivery).toEqual([
      { agentId: "agt_m_kid2", state: "delivered" },
      { agentId: "agt_m_kid1", state: "delivered" },
    ]);
  });

  it("still names everyone when it sends the missed copy again", async () => {
    const { svc: failing } = build({ failFor: ["agt_m_kid1"] });
    const res = await failing.sendUserPost(A, {
      text: "@builder and @reviewer, please look",
    });
    await settled(failing, res.block.id);
    const { svc, injected } = build();
    await svc.retryDelivery(A, res.block.id);
    await settled(svc, res.block.id);
    expect(injected[0]!.text).toContain(
      "Addressed to you by @mention, and also to builder."
    );
  });

  it("marks every recipient still waiting as failed when the process died under them", async () => {
    const { svc } = build({ gate: never, failFor: ["agt_m_kid1"] });
    const res = await svc.sendUserPost(A, {
      text: "@builder and @reviewer, still there?",
    });
    expect(res.block.delivered).toBeNull();
    await svc.store.sweepPendingDeliveries();
    const block = await svc.store.getById(res.block.id);
    expect(block!.delivered).toBe(false);
    expect(block!.delivery).toEqual([
      { agentId: "agt_m_kid2", state: "failed" },
      { agentId: "agt_m_kid1", state: "failed" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The launch card: the workspace coming up, the instructions, the briefing
// ---------------------------------------------------------------------------

describe("StreamService launch card", () => {
  const cardsOf = async (agentId: string) => {
    const rows = await pool.query<{
      id: string;
      text: string;
      state: Record<string, unknown> | null;
      data: unknown;
      origin: string | null;
      thread_id: string | null;
    }>(
      `SELECT id, text, state, data, origin, thread_id FROM blocks
        WHERE to_agent_id = $1 AND kind = 'launch'`,
      [agentId]
    );
    return rows.rows;
  };
  const startupOf = async (svc: StreamService) => {
    void svc;
    const cards = await cardsOf(A);
    expect(cards).toHaveLength(1);
    return cards[0]!.state!.startup as {
      steps: Array<{
        phase: string;
        label: string;
        status: string;
        endedAt?: string;
        detail?: string;
      }>;
      readyAt?: string;
      failed?: string;
      cwd?: string;
    };
  };

  it("keeps one block per agent and ends the step before as each phase starts", async () => {
    const { svc, events } = build();
    await svc.recordStartupStep({
      agentId: A,
      phase: "worktree",
      label: "Creating git worktree",
    });
    await svc.recordStartupStep({
      agentId: A,
      phase: "deps",
      label: "Installing dependencies",
    });
    const startup = await startupOf(svc);
    expect(startup.steps).toMatchObject([
      { phase: "worktree", status: "done" },
      { phase: "deps", status: "running" },
    ]);
    expect(startup.steps[0]!.endedAt).toBeTruthy();
    // Every change is published, so the row moves while the person watches
    // (the first one also writes the card).
    const entries = events.filter(
      (e) => (e as { type: string }).type === "stream.entry"
    );
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(
      entries.every(
        (e) => (e as { entry: { id: string } }).entry.id === launchBlockId(A)
      )
    ).toBe(true);
  });

  it("writes the startup onto the card's state, with no text of its own", async () => {
    const { svc } = build();
    await svc.recordStartupStep({
      agentId: A,
      phase: "deps",
      label: "Installing dependencies",
    });
    const during = await svc.store.getById(launchBlockId(A));
    expect(during).toMatchObject({
      kind: "launch",
      author: { kind: "user" },
      toAgentId: A,
      threadId: null,
      delivered: true,
      text: "",
    });
    expect("origin" in during!).toBe(false);
    await svc.recordStartupDone({ agentId: A, cwd: "/tmp/work" });
    const after = await svc.store.getById(launchBlockId(A));
    expect(after!.text).toBe("");
    const startup = await startupOf(svc);
    expect(startup.readyAt).toBeTruthy();
    expect(startup.cwd).toBe("/tmp/work");
    expect(startup.steps.every((step) => step.status === "done")).toBe(true);
  });

  it("marks the step that was running as the one that failed", async () => {
    const { svc } = build();
    await svc.recordStartupStep({
      agentId: A,
      phase: "worktree",
      label: "Creating git worktree",
    });
    await svc.recordStartupDone({
      agentId: A,
      error: "branch already checked out",
    });
    const startup = await startupOf(svc);
    expect(startup.failed).toBe("branch already checked out");
    expect(startup.steps[0]).toMatchObject({
      status: "failed",
      detail: "branch already checked out",
    });
  });

  it("does not repeat a phase it already recorded", async () => {
    const { svc } = build();
    await svc.recordStartupStep({
      agentId: A,
      phase: "deps",
      label: "Installing dependencies",
    });
    await svc.recordStartupStep({
      agentId: A,
      phase: "deps",
      label: "Installing dependencies",
    });
    const startup = await startupOf(svc);
    expect(startup.steps).toHaveLength(1);
  });

  it("never counts as something the agent said to the person", async () => {
    const { svc } = build();
    await svc.recordStartupStep({
      agentId: A,
      phase: "deps",
      label: "Installing dependencies",
    });
    await svc.recordStartupDone({ agentId: A });
    await svc.recordSystemPrompt({ agentId: A, prompt: "Be useful." });
    // The card is the person's post to the agent: no unread mark.
    expect(await svc.store.countUnread(A)).toBe(0);
  });

  it("keeps the instructions on the card, rewritten only when they change", async () => {
    const { svc, events } = build();
    const first = await svc.recordSystemPrompt({
      agentId: A,
      prompt: "  Be useful.  ",
    });
    expect(first).toMatchObject({
      id: launchBlockId(A),
      kind: "launch",
      state: { instructions: "Be useful." },
    });
    const count = events.length;
    // The same guidance again writes and publishes nothing.
    await svc.recordSystemPrompt({ agentId: A, prompt: "Be useful." });
    expect(events).toHaveLength(count);
    await svc.recordSystemPrompt({ agentId: A, prompt: "Be brief." });
    const cards = await cardsOf(A);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.state).toEqual({ instructions: "Be brief." });
    expect(
      await svc.recordSystemPrompt({ agentId: A, prompt: "   " })
    ).toBeNull();
  });

  it("lands the startup, the instructions and the briefing on one card, whichever comes first", async () => {
    const orders: Array<Array<"step" | "prompt" | "brief" | "done">> = [
      ["step", "prompt", "brief", "done"],
      ["brief", "step", "prompt", "done"],
      ["prompt", "brief", "step", "done"],
      ["brief", "prompt", "done", "step"],
    ];
    for (const order of orders) {
      await pool.query("DELETE FROM blocks");
      const { svc } = build();
      for (const step of order) {
        if (step === "step") {
          await svc.recordStartupStep({
            agentId: A,
            phase: "deps",
            label: "Installing dependencies",
          });
        } else if (step === "prompt") {
          await svc.recordSystemPrompt({ agentId: A, prompt: "Be useful." });
        } else if (step === "done") {
          await svc.recordStartupDone({ agentId: A });
        } else {
          const prepared = await svc.prepareLaunchContext({
            agentId: A,
            text: "Build the widget",
            links: ["https://example.com/spec"],
          });
          // The card's id is known before the write, whoever wrote it.
          expect(prepared!.id).toBe(launchBlockId(A));
          await prepared!.record();
        }
      }
      const cards = await cardsOf(A);
      expect(cards, order.join(",")).toHaveLength(1);
      expect(cards[0]).toMatchObject({
        id: launchBlockId(A),
        text: "Build the widget",
        origin: null,
        data: null,
        thread_id: null,
        state: {
          instructions: "Be useful.",
          startup: expect.objectContaining({ steps: expect.any(Array) }),
        },
      });
      const all = await pool.query(
        `SELECT count(*)::int AS n FROM blocks WHERE stream_id = $1`,
        [A]
      );
      expect(all.rows[0].n, order.join(",")).toBe(1);
    }
  });

  it("writes the card in the parent's stream, attributed only by the launch, never the agent row", async () => {
    const CHILD = "agt_stream_card_child";
    AGENTS[CHILD] = {
      id: CHILD,
      name: "Kid",
      filesDir: null,
      status: "running",
    };
    await pool.query(
      `INSERT INTO agents (id, name, cwd, status, parent_agent_id, launched_by_agent_id)
       VALUES ($1, 'Kid', '/tmp', 'running', $2, $2)
       ON CONFLICT (id) DO UPDATE SET parent_agent_id = EXCLUDED.parent_agent_id,
         launched_by_agent_id = EXCLUDED.launched_by_agent_id, deleted_at = NULL`,
      [CHILD, A]
    );
    try {
      const { svc } = build();
      // The agent row names a launcher (a create request can fill that in),
      // but the card does not take it from there.
      const card = await svc.ensureLaunchBlock(CHILD);
      expect(card).toMatchObject({
        id: launchBlockId(CHILD),
        streamId: A,
        kind: "launch",
        toAgentId: CHILD,
        threadId: null,
      });
      expect("launchedByAgentId" in card).toBe(false);
      // Asked again, it is the same card.
      expect((await svc.ensureLaunchBlock(CHILD)).id).toBe(card.id);
      expect((await svc.store.findLaunchBlock(CHILD))?.id).toBe(card.id);
      // A launch with no briefing still says who launched it, and returns
      // nothing to record.
      expect(
        await svc.prepareLaunchContext({ agentId: CHILD, launchedByAgentId: A })
      ).toBeNull();
      expect(await svc.store.findLaunchBlock(CHILD)).toMatchObject({
        id: card.id,
        launchedByAgentId: A,
        text: "",
      });
    } finally {
      await pool.query(`DELETE FROM agents WHERE id = $1`, [CHILD]);
      delete AGENTS[CHILD];
    }
  });
});

describe("StreamService.retryTurn", () => {
  /** The agent's newest turn, failed; `retry` as the recorder left it. */
  async function failedTurn(retry: string | null = "open") {
    await pool.query("DELETE FROM agent_stream_events WHERE agent_id = $1", [
      A,
    ]);
    const row = await pool.query<{ id: string }>(
      `INSERT INTO agent_stream_events (agent_id, seq, kind, payload)
       VALUES ($1, 1, 'turn', $2::jsonb) RETURNING id`,
      [
        A,
        JSON.stringify({
          state: "settled",
          prompt: { source: "system", text: "go" },
          error: "API Error: 500 Internal server error.",
          errorKind: "server_error",
          ...(retry ? { retry } : {}),
        }),
      ]
    );
    const turnId = Number(row.rows[0]!.id);
    const block = await service.store.insert({
      streamId: A,
      author: { kind: "agent", agentId: A },
      kind: "text",
      origin: "turn",
      data: { turnEventId: turnId },
      text: "",
    });
    await pool.query(
      `UPDATE agent_stream_events SET payload = payload || $2::jsonb WHERE id = $1`,
      [turnId, JSON.stringify({ blockId: block.id })]
    );
    return { turnId, blockId: block.id };
  }

  async function retryOf(turnId: number): Promise<unknown> {
    const res = await pool.query<{ retry: string | null }>(
      `SELECT payload->>'retry' AS retry FROM agent_stream_events WHERE id = $1`,
      [turnId]
    );
    return res.rows[0]?.retry ?? null;
  }

  it("tells the agent its turn broke off, once, and the entry says retried", async () => {
    const { turnId, blockId } = await failedTurn();
    const { svc, injected, injectedOpts, events } = build();
    await svc.retryTurn(A, blockId);
    await svc.waitForInFlightDeliveries(1_000);
    expect(injected).toEqual([
      {
        agentId: A,
        text: expect.stringMatching(
          /^The user retried the turn that stopped on an error\. Continue where you left off\.\n\(The error was API Error: 500 Internal server error\.\)$/s
        ),
      },
    ]);
    // The original prompt is not sent again.
    expect(injected[0]!.text).not.toContain("go\n");
    // A prompt of Dispatch's own, not the failed turn's block again.
    expect(injectedOpts).toEqual([
      {
        source: { source: "system", text: expect.stringContaining("Retried") },
      },
    ]);
    expect(await retryOf(turnId)).toBe("retried");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "stream.entry",
        entry: expect.objectContaining({
          block: expect.objectContaining({
            id: blockId,
            turn: expect.objectContaining({ retry: "retried" }),
          }),
        }),
      })
    );
    await expect(svc.retryTurn(A, blockId)).rejects.toBeInstanceOf(
      StreamConflictError
    );
    expect(injected).toHaveLength(1);
  });

  it("refuses a turn the agent has had another turn since", async () => {
    const { blockId } = await failedTurn();
    await pool.query(
      `INSERT INTO agent_stream_events (agent_id, seq, kind, payload)
       VALUES ($1, 2, 'turn', '{"state":"settled","prompt":{"source":"system","text":"next"}}')`,
      [A]
    );
    const { svc, injected } = build();
    await expect(svc.retryTurn(A, blockId)).rejects.toThrow(/latest turn/);
    expect(injected).toEqual([]);
  });

  it("refuses a failure a retry cannot clear", async () => {
    const { blockId } = await failedTurn(null);
    const { svc, injected } = build();
    await expect(svc.retryTurn(A, blockId)).rejects.toBeInstanceOf(
      StreamConflictError
    );
    expect(injected).toEqual([]);
  });

  it("keeps offering the retry when the agent can't take it", async () => {
    const { turnId, blockId } = await failedTurn();
    const { svc, injected } = build({ access: inert });
    await expect(svc.retryTurn(A, blockId)).rejects.toThrow("No engine.");
    expect(injected).toEqual([]);
    expect(await retryOf(turnId)).toBe("open");
  });

  it("offers the retry again when the prompt never reached the agent", async () => {
    const { turnId, blockId } = await failedTurn();
    const { svc } = build({ fail: true });
    await svc.retryTurn(A, blockId);
    await svc.waitForInFlightDeliveries(1_000);
    expect(await retryOf(turnId)).toBe("open");
  });
});
