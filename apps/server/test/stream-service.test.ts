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
} from "../src/chat/service.js";
import type { Block } from "@dispatch/shared";
import { BLOCK_ATTACHMENTS_MAX, BLOCK_TEXT_MAX_CHARS } from "@dispatch/shared";
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
    deps?: Partial<StreamServiceDeps>;
    withDelivery?: boolean;
  } = {}
) {
  const events: unknown[] = [];
  const injected: Injected[] = [];
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
            inject: async (agentId, text) => {
              if (opts.gate) await opts.gate;
              injected.push({ agentId, text });
              if (opts.fail) throw new Error("engine gone");
            },
            held: () => opts.held ?? false,
            cancel: async (agentId) => {
              cancelled.push(agentId);
            },
          },
        }),
    ...opts.deps,
  });
  return { svc, events, injected, cancelled };
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
  const result = await pool.query<{ id: number }>(
    `INSERT INTO files (agent_id, file_name, source, size_bytes)
     VALUES ($1, $2, 'user', $3) RETURNING id`,
    [agentId, fileName, size]
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
      streamId: A,
      author: { kind: "user" },
      toAgentId: A,
      kind: "text",
      text: "Build the widget",
      delivered: true,
      origin: "launch",
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
      origin: "launch",
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
      id: "8a4f9e60-1111-4222-8333-444455556666",
      agentId: A,
      text: "Build the widget",
      files: [{ fileId }],
      links: ["https://example.com/spec"],
    });
    expect(prepared?.id).toBe("8a4f9e60-1111-4222-8333-444455556666");
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
    expect(block.id).toBe("8a4f9e60-1111-4222-8333-444455556666");
    expect(block).toMatchObject({
      origin: "launch",
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

  it("refuses to write a block whose id is already taken", async () => {
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
    await expect(second!.record()).rejects.toBeInstanceOf(StreamConflictError);
    const rows = await pool.query<{ text: string }>(
      "SELECT text FROM blocks WHERE id = $1",
      [id]
    );
    expect(rows.rows).toEqual([{ text: "First" }]);
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
        review: { verdict: "approve", summary: "ok", findings: [] },
      }).kind
    ).toBe("review");
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

  it("validates a review: verdict, findings, severities, unique ids", () => {
    const finding = {
      id: "f1",
      severity: "major",
      title: "t",
      body: "b",
    } as const;
    expect(
      resolveKindAndData({
        review: {
          verdict: "request_changes",
          summary: "s",
          findings: [finding],
        },
      }).data
    ).toEqual({
      verdict: "request_changes",
      summary: "s",
      findings: [finding],
    });
    expect(() =>
      resolveKindAndData({
        review: { verdict: "lgtm", summary: "s", findings: [] } as never,
      })
    ).toThrow(/verdict must be approve, request_changes or comment/);
    expect(() =>
      resolveKindAndData({
        review: { verdict: "approve", summary: "s" } as never,
      })
    ).toThrow(/needs verdict, summary and findings/);
    expect(() =>
      resolveKindAndData({
        review: {
          verdict: "approve",
          summary: "s",
          findings: [{ ...finding, severity: "huge" as never }],
        },
      })
    ).toThrow(/finding "f1" has an unknown severity/);
    expect(() =>
      resolveKindAndData({
        review: {
          verdict: "approve",
          summary: "s",
          findings: [finding, finding],
        },
      })
    ).toThrow(/Duplicate finding id "f1"/);
    expect(() =>
      resolveKindAndData({
        review: {
          verdict: "approve",
          summary: "s",
          findings: Array.from({ length: 51 }, (_, i) => ({
            ...finding,
            id: `f${i}`,
          })),
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
        verdict: "request_changes",
        summary: "s",
        findings: [
          { id: "f1", severity: "major", title: "a", body: "b" },
          { id: "f2", severity: "nit", title: "c", body: "d" },
        ],
      },
    });
    expect(review.kind).toBe("review");
    expect(review.state).toEqual({
      findings: {
        f1: { status: "open", by: { kind: "user" }, at: expect.any(String) },
        f2: { status: "open", by: { kind: "user" }, at: expect.any(String) },
      },
    });
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
      `INSERT INTO files (agent_id, file_name, source, size_bytes)
       VALUES ($1, 'shot-2026-01-01-00-00-00-000.png', 'screenshot', 123),
              ($1, 'report.pdf', 'screenshot', 456),
              ($2, 'theirs.png', 'screenshot', 1)`,
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
      },
      {
        type: "file",
        fileId: pdf.rows[0].id,
        fileName: "report.pdf",
        sizeBytes: 456,
        mimeType: "application/pdf",
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
          `INSERT INTO files (agent_id, file_name, source, size_bytes, description)
         VALUES ($1, 'shot-uploaded.png', 'screenshot', 77, $2)`,
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
      `INSERT INTO files (agent_id, file_name, source, size_bytes, metadata)
       VALUES ($1, 'measured.png', 'screenshot', 9, '{"width":120,"height":90}'::jsonb)`,
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
    // then its root with the changed reply count, then the root once more
    // for the thread it landed in.
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
      expect.objectContaining({
        type: "stream.entry",
        entry: expect.objectContaining({ id: root.id }),
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
        `INSERT INTO files (agent_id, file_name, source, size_bytes)
         VALUES ($1, 'late.png', 'screenshot', 5)`,
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

  it("merges state on the agent's own review and tasks, stamped by the agent", async () => {
    const review = await service.post(A, {
      review: {
        verdict: "comment",
        summary: "s",
        findings: [
          { id: "f1", severity: "major", title: "a", body: "b" },
          { id: "f2", severity: "nit", title: "c", body: "d" },
        ],
      },
    });
    const resolved = await service.update(A, review.id, {
      state: { findings: { f1: "resolved" } },
    });
    expect(resolved.state).toEqual({
      findings: {
        f1: {
          status: "resolved",
          resolution: "fixed",
          by: { kind: "agent", agentId: A },
          at: expect.any(String),
        },
        f2: { status: "open", by: { kind: "user" }, at: expect.any(String) },
      },
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
      service.update(A, review.id, {
        state: { findings: { f1: { status: "wontfix" } } },
      })
    ).rejects.toThrow(/must be open, fixed or dismissed/);
    await expect(
      service.update(A, review.id, { state: { items: {} } })
    ).rejects.toThrow(/state\.findings is required/);
    await expect(
      service.update(A, tasks.id, { state: { findings: {} } })
    ).rejects.toThrow(/state\.items is required/);
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
    // Freeform closes with the words given; the rail no longer lists it.
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
        verdict: "request_changes",
        summary: "s",
        findings: [{ id: "f1", severity: "major", title: "a", body: "b" }],
      },
    });
    await settled(svc, review.id);
    injected.length = 0;
    await expect(
      svc.update(A, review.id, { text: "mine now" })
    ).rejects.toBeInstanceOf(StreamForbiddenError);
    await expect(svc.update(A, review.id, { data: {} })).rejects.toBeInstanceOf(
      StreamForbiddenError
    );
    await expect(
      svc.update(A, review.id, { attachments: [] })
    ).rejects.toBeInstanceOf(StreamForbiddenError);
    await expect(svc.update(A, review.id, {})).rejects.toThrow(
      /state is required/
    );
    const resolved = await svc.update(A, review.id, {
      state: { findings: { f1: "fixed" } },
    });
    expect(resolved.state).toEqual({
      findings: {
        f1: {
          status: "resolved",
          resolution: "fixed",
          by: { kind: "agent", agentId: A },
          at: expect.any(String),
        },
      },
    });
    // The author hears about it.
    await svc.waitForInFlightDeliveries(1_000);
    expect(injected).toEqual([
      {
        agentId: B,
        text: expect.stringContaining(
          `--- DISPATCH POST (id: ${review.id}, from: Svc (${A})) ---\nFinding f1 fixed.\nVerify the resolution`
        ),
      },
    ]);
    // A third agent may not.
    await expect(
      svc.update("agt_third", review.id, {
        state: { findings: { f1: "open" } },
      })
    ).rejects.toBeInstanceOf(StreamForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// People: posts, answers, forms, state
// ---------------------------------------------------------------------------

describe("StreamService.sendUserPost", () => {
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
    ).toEqual([res.block.id, root.id, root.id]);
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

describe("StreamService.setState", () => {
  async function review(
    svc: StreamService,
    author = A,
    to: string | null = null
  ) {
    return svc.post(author, {
      ...(to ? { to } : {}),
      review: {
        verdict: "request_changes",
        summary: "s",
        findings: [
          { id: "f1", severity: "major", title: "a", body: "b" },
          { id: "f2", severity: "minor", title: "c", body: "d" },
        ],
      },
    });
  }

  it("lets a person resolve a finding, stamped, keeping the rest, and tells the author", async () => {
    const { svc, events, injected } = build();
    const r = await review(svc);
    events.length = 0;
    const updated = await svc.setState(
      A,
      r.id,
      { findings: { f1: "resolved" } },
      { kind: "user" }
    );
    expect(updated.state).toEqual({
      findings: {
        f1: {
          status: "resolved",
          resolution: "fixed",
          by: { kind: "user" },
          at: expect.any(String),
        },
        f2: { status: "open", by: { kind: "user" }, at: expect.any(String) },
      },
    });
    expect(events).toEqual([entryEvent(updated)]);
    await svc.waitForInFlightDeliveries(1_000);
    expect(injected).toEqual([
      {
        agentId: A,
        text: [
          `--- DISPATCH POST (id: ${r.id}, from: user) ---`,
          "Finding f1 fixed.",
          "Verify the resolution when you can; reopen the finding with a note if it falls short.",
          "--- END DISPATCH POST ---",
          "Your reply appears in the stream as you write it. Use post only for a question with options, a file, a link, or to reach another agent.",
        ].join("\n"),
      },
    ]);
    // Reopen with a note and dismiss with one, several at once, in record form.
    const again = await svc.setState(
      A,
      r.id,
      {
        findings: {
          f1: { status: "open", note: "Still spins after a timeout." },
          f2: {
            status: "resolved",
            resolution: "dismissed",
            note: "Not ours.",
          },
        },
      },
      { kind: "user" }
    );
    expect(again.state).toMatchObject({
      findings: {
        f1: { status: "open", note: "Still spins after a timeout." },
        f2: { status: "resolved", resolution: "dismissed", note: "Not ours." },
      },
    });
    expect(
      (again.state as { findings: Record<string, object> }).findings.f1
    ).not.toHaveProperty("resolution");
    await svc.waitForInFlightDeliveries(1_000);
    expect(injected[1]?.text).toContain(
      "Finding f1 reopened: Still spins after a timeout.\nFinding f2 dismissed: Not ours.\nThe agent whose work this is will address it"
    );
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
    const r = await review(inertSvc.svc);
    await inertSvc.svc.setState(
      A,
      r.id,
      { findings: { f1: "resolved" } },
      { kind: "user" }
    );
    expect(inertSvc.injected).toEqual([]);
    const { svc, injected } = build();
    const own = await review(svc);
    await svc.setState(
      A,
      own.id,
      { findings: { f1: "resolved" } },
      { kind: "agent", agentId: A }
    );
    await svc.waitForInFlightDeliveries(1_000);
    expect(injected).toEqual([]);
  });

  it("allows the author and the recipient, and no other agent", async () => {
    const { svc, injected } = build();
    // B's review of A's work lives on B's own stream in step 1.
    const r = await review(svc, B, A);
    await settled(svc, r.id);
    injected.length = 0;
    await expect(
      svc.setState(
        B,
        r.id,
        { findings: { f1: "resolved" } },
        { kind: "agent", agentId: "agt_third" }
      )
    ).rejects.toBeInstanceOf(StreamForbiddenError);
    const byRecipient = await svc.setState(
      B,
      r.id,
      { findings: { f1: "resolved" } },
      { kind: "agent", agentId: A }
    );
    expect(byRecipient.state).toMatchObject({
      findings: {
        f1: { status: "resolved", by: { kind: "agent", agentId: A } },
      },
    });
    await svc.waitForInFlightDeliveries(1_000);
    expect(injected).toEqual([
      { agentId: B, text: expect.stringContaining(`from: Svc (${A})`) },
    ]);
    const byAuthor = await svc.setState(
      B,
      r.id,
      { findings: { f2: "resolved" } },
      { kind: "agent", agentId: B }
    );
    expect(byAuthor.state).toMatchObject({
      findings: {
        f2: { status: "resolved", by: { kind: "agent", agentId: B } },
      },
    });
    // The reviewer reopening tells the builder it is its move.
    injected.length = 0;
    await svc.setState(
      B,
      r.id,
      { findings: { f1: { status: "open", note: "Still wrong." } } },
      { kind: "agent", agentId: B }
    );
    await svc.waitForInFlightDeliveries(1_000);
    expect(injected).toEqual([
      {
        agentId: A,
        text: expect.stringContaining(
          "Finding f1 reopened: Still wrong.\nA reopened finding is yours to address"
        ),
      },
    ]);
  });

  it("maps unknown or foreign blocks, stateless kinds and bad patches to errors", async () => {
    const { svc } = build();
    await expect(
      svc.setState(A, NIL, { findings: {} }, { kind: "user" })
    ).rejects.toBeInstanceOf(StreamNotFoundError);
    await expect(
      svc.setState(A, "nope", { findings: {} }, { kind: "user" })
    ).rejects.toBeInstanceOf(StreamNotFoundError);
    const r = await review(svc);
    await expect(
      svc.setState(B, r.id, { findings: {} }, { kind: "user" })
    ).rejects.toBeInstanceOf(StreamNotFoundError);
    const text = await svc.post(A, { text: "plain" });
    await expect(
      svc.setState(A, text.id, { items: {} }, { kind: "user" })
    ).rejects.toThrow(/A text block has no state/);
    const q = await svc.post(A, { question: { options: [{ label: "a" }] } });
    await expect(
      svc.setState(A, q.id, { answer: {} }, { kind: "user" })
    ).rejects.toThrow(/A question block has no state/);
    await expect(svc.setState(A, r.id, {}, { kind: "user" })).rejects.toThrow(
      /state\.findings is required/
    );
    await expect(
      svc.setState(A, r.id, { findings: { f1: "disputed" } }, { kind: "user" })
    ).rejects.toThrow(/finding "f1" must be open, fixed or dismissed/);
    await expect(
      svc.setState(
        A,
        r.id,
        { findings: { f1: { status: "resolved", resolution: "later" } } },
        { kind: "user" }
      )
    ).rejects.toThrow(/finding "f1" must be open, fixed or dismissed/);
    expect(await svc.store.getById(r.id)).toEqual(r);
  });
});

// ---------------------------------------------------------------------------
// Review threads: who a comment reaches, which finding it is about
// ---------------------------------------------------------------------------

describe("StreamService review threads", () => {
  // The reviewer is the builder's child, as a persona launch makes it:
  // both post into A's stream.
  beforeAll(async () => {
    await pool.query(`UPDATE agents SET parent_agent_id = $1 WHERE id = $2`, [
      A,
      B,
    ]);
  });
  afterAll(async () => {
    await pool.query(`UPDATE agents SET parent_agent_id = NULL WHERE id = $1`, [
      B,
    ]);
  });

  /** B reviews A's work: the review lands on A's stream, addressed to A. */
  async function reviewed(svc: StreamService) {
    const r = await svc.post(B, {
      to: A,
      review: {
        verdict: "request_changes",
        summary: "s",
        findings: [
          { id: "f1", severity: "major", title: "a", body: "b" },
          { id: "f2", severity: "minor", title: "c", body: "d" },
        ],
      },
    });
    await settled(svc, r.id);
    return r;
  }

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

  it("closes a question asked of an agent with that agent's reply, and keeps it on its finding", async () => {
    const { svc, injected } = build();
    const r = await reviewed(svc);
    // The reviewer asks the builder something under a finding.
    const q = await svc.post(B, {
      text: "Keep the hard cut, or return empty?",
      question: { options: [{ label: "Keep it" }, { label: "Return empty" }] },
      replyTo: r.id,
      finding: "f2",
    });
    expect(q).toMatchObject({
      kind: "question",
      toAgentId: A,
      threadId: r.id,
      data: { findingId: "f2" },
    });
    await settled(svc, q.id);
    injected.length = 0;
    // The builder's reply answers it: an option's label closes it as that
    // option, and the envelope says so.
    const reply = await svc.post(A, { text: "Keep it", replyTo: q.id });
    expect(reply).toMatchObject({
      toAgentId: B,
      threadId: r.id,
      data: { findingId: "f2" },
    });
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
    expect((await svc.store.getById(q.id))?.state?.answer?.blockId).toBe(
      reply.id
    );
    expect(more.kind).toBe("text");
    // A reply by someone the question was not asked of answers nothing.
    const other = await svc.post(B, {
      text: "Return empty?",
      question: { options: [{ label: "Yes" }] },
      replyTo: r.id,
    });
    await settled(svc, other.id);
    await svc.post(B, { text: "Yes", replyTo: other.id, to: A });
    expect((await svc.store.getById(other.id))?.state?.answer).toBeUndefined();
  });

  it("posts a review top-level even when the reviewer replies into its launch thread", async () => {
    const { svc } = build();
    const briefing = await svc.sendUserPost(A, {
      to: B,
      text: "Please review src/x.ts.",
    });
    const r = await svc.post(B, {
      to: A,
      replyTo: briefing.block.id,
      review: {
        verdict: "request_changes",
        summary: "s",
        findings: [{ id: "f1", severity: "major", title: "a", body: "b" }],
      },
    });
    expect(r).toMatchObject({ threadId: null, replyTo: null, toAgentId: A });
    await settled(svc, r.id);
    const comment = await svc.post(A, {
      text: "Done.",
      replyTo: r.id,
      finding: "f1",
    });
    expect(comment).toMatchObject({
      threadId: r.id,
      data: { findingId: "f1" },
    });
  });

  it("sends each comment to one side: the builder's to the reviewer, the reviewer's to the builder", async () => {
    const { svc, injected } = build();
    const r = await reviewed(svc);
    injected.length = 0;
    const fromBuilder = await svc.post(A, {
      text: "Fixed in 3b2.",
      replyTo: r.id,
      finding: "f1",
    });
    expect(fromBuilder).toMatchObject({
      toAgentId: B,
      data: { findingId: "f1" },
    });
    await settled(svc, fromBuilder.id);
    expect(injected.map((i) => i.agentId)).toEqual([B]);
    expect(injected[0]?.text).toContain('About finding "f1" (a).');

    injected.length = 0;
    const fromReviewer = await svc.post(B, {
      text: "Still spins for me.",
      replyTo: r.id,
      finding: "f1",
    });
    expect(fromReviewer.toAgentId).toBe(A);
    await settled(svc, fromReviewer.id);
    expect(injected.map((i) => i.agentId)).toEqual([A]);
  });

  it("routes a person's comment to whoever's move it is, and a reply to a comment to its author", async () => {
    const { svc, injected } = build();
    const r = await reviewed(svc);
    injected.length = 0;
    // f1 is open: the builder has to act.
    const onOpen = await svc.sendUserPost(A, {
      text: "Please handle this first.",
      replyTo: r.id,
      finding: "f1",
    });
    expect(onOpen.block).toMatchObject({
      toAgentId: A,
      data: { findingId: "f1" },
    });
    await settled(svc, onOpen.block.id);
    expect(injected.map((i) => i.agentId)).toEqual([A]);

    // f2 resolved: the reviewer checks it.
    await svc.setState(
      A,
      r.id,
      { findings: { f2: "fixed" } },
      { kind: "agent", agentId: A }
    );
    await svc.waitForInFlightDeliveries(1_000);
    injected.length = 0;
    const onResolved = await svc.sendUserPost(A, {
      text: "Does this hold up?",
      replyTo: r.id,
      finding: "f2",
    });
    expect(onResolved.block.toAgentId).toBe(B);
    await settled(svc, onResolved.block.id);
    expect(injected.map((i) => i.agentId)).toEqual([B]);

    // Answering the builder's comment goes to the builder, and inherits its finding.
    const builderSaid = await svc.post(A, {
      text: "Done.",
      replyTo: r.id,
      finding: "f2",
    });
    await settled(svc, builderSaid.id);
    injected.length = 0;
    const answer = await svc.sendUserPost(A, {
      text: "Thanks.",
      replyTo: builderSaid.id,
    });
    expect(answer.block).toMatchObject({
      toAgentId: A,
      threadId: r.id,
      replyTo: builderSaid.id,
      data: { findingId: "f2" },
    });
    await settled(svc, answer.block.id);
    expect(injected.map((i) => i.agentId)).toEqual([A]);
    expect(injected[0]?.text).toContain('About finding "f2" (c).');
  });

  it("marks a thread's agent comments read, by finding or all of them", async () => {
    const { svc } = build();
    const r = await reviewed(svc);
    const c1 = await svc.post(A, { text: "one", replyTo: r.id, finding: "f1" });
    const c2 = await svc.post(B, { text: "two", replyTo: r.id, finding: "f2" });
    const c3 = await svc.post(B, { text: "three", replyTo: r.id });
    await svc.sendUserPost(A, { text: "mine", replyTo: r.id, finding: "f1" });
    const first = await svc.store.markThreadRead(A, r.id, "f1");
    expect(first.ids).toEqual([c1.id]);
    expect(first.readAt).toEqual(expect.any(String));
    const rest = await svc.store.markThreadRead(A, r.id);
    expect(rest.ids.sort()).toEqual([c2.id, c3.id].sort());
    expect(await svc.store.markThreadRead(A, r.id)).toEqual({
      ids: [],
      readAt: null,
    });
    const replies = (await svc.store.listThread(r.id))!.replies;
    expect(
      replies.filter((b) => b.author.kind === "agent").every((b) => b.readAt)
    ).toBe(true);
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
        payload: { state: "settled", blockId, prompt: { source: "chat", text: "go" } },
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
        block: { text: "All done.", turn: { settled: true, result: { text: "All done." } } },
      },
    });
    expect(published[1]).toEqual({ type: "stream.changed", agentId: A });
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

  it("a turn opened by a comment on a finding answers on that finding", async () => {
    const review = await service.store.insert({
      streamId: A,
      author: { kind: "agent", agentId: B },
      toAgentId: A,
      kind: "review",
      text: "",
      data: {
        verdict: "request_changes",
        summary: "One thing.",
        findings: [{ id: "f1", severity: "major", title: "Null", body: "Guard." }],
      },
      state: { findings: {} },
    });
    const comment = await service.store.insert({
      streamId: A,
      author: { kind: "user" },
      toAgentId: A,
      threadId: review.id,
      replyTo: review.id,
      text: "fix it?",
      data: { findingId: "f1" },
      delivered: true,
    });
    const blockId = await service.recordTurnStarted({
      agentId: A,
      turnRow: turnRow(8, { source: "chat", chatMessageId: comment.id }),
      prompt: { source: "chat", text: "fix it?", chatMessageId: comment.id },
    });
    expect(await service.store.getById(blockId!)).toMatchObject({
      threadId: review.id,
      replyTo: comment.id,
      data: { findingId: "f1" },
    });
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
    AGENTS["agt_m_kid1"] = { id: "agt_m_kid1", name: "reviewer", filesDir: null, status: "running" };
    AGENTS["agt_m_kid2"] = { id: "agt_m_kid2", name: "builder", filesDir: null, status: "running" };
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
    const res = await svc.sendUserPost(A, { text: "@Peer is not in this tree" });
    expect(res.block.toAgentId).toBe(A);
    expect(res.block.kind === "text" && res.block.data?.mentions).toBeUndefined();
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
