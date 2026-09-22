/**
 * 0005 turns an agent's launch rows (a `launch` post, a `workspace` row, a
 * `system_prompt` row) into its one launch card, drops review-request rows,
 * and turns a review's inline findings into `finding` blocks with their
 * comments moved under them. The migrations run up to 0004, old-shaped rows
 * are seeded, and the rest runs over them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { runMigrations } from "../../src/db/migrate.js";
import { getTestDatabaseUrl, setupTestDb, teardownTestDb } from "./setup.js";

let pool: Pool;

const PARENT = "agt_mig_parent";
const CHILD = "agt_mig_child";
const BARE = "agt_mig_bare";

const ID = {
  launch: "10000000-0000-4000-8000-000000000001",
  childWorkspace: "10000000-0000-4000-8000-000000000002",
  childPrompt: "10000000-0000-4000-8000-000000000003",
  bareWorkspace: "10000000-0000-4000-8000-000000000004",
  barePrompt: "10000000-0000-4000-8000-000000000005",
  request: "10000000-0000-4000-8000-000000000006",
  review: "10000000-0000-4000-8000-000000000007",
  onF1: "10000000-0000-4000-8000-000000000008",
  replyOnF1: "10000000-0000-4000-8000-000000000009",
  general: "10000000-0000-4000-8000-00000000000a",
  askOnF2: "10000000-0000-4000-8000-00000000000b",
  turn: "10000000-0000-4000-8000-00000000000c",
};

const STARTUP = {
  steps: [{ phase: "deps", label: "Installing dependencies", status: "done" }],
  readyAt: "2026-01-01T00:00:05.000Z",
};

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));

type Row = {
  id: string;
  kind: string;
  origin: string | null;
  author_kind: string;
  author_agent_id: string | null;
  to_agent_id: string | null;
  launched_by_agent_id: string | null;
  thread_id: string | null;
  reply_to: string | null;
  text: string;
  data: Record<string, unknown> | null;
  state: Record<string, unknown> | null;
  delivered: boolean | null;
};

async function row(id: string): Promise<Row | undefined> {
  const result = await pool.query<Row>(`SELECT * FROM blocks WHERE id = $1`, [
    id,
  ]);
  return result.rows[0];
}

async function insert(values: {
  id: string;
  stream: string;
  authorKind: "user" | "agent";
  author?: string | null;
  to?: string | null;
  kind?: string;
  origin?: string | null;
  threadId?: string | null;
  replyTo?: string | null;
  text?: string;
  data?: unknown;
  state?: unknown;
  launchedBy?: string | null;
  delivered?: boolean | null;
  at: Date;
}): Promise<void> {
  await pool.query(
    `INSERT INTO blocks
       (id, stream_id, author_kind, author_agent_id, to_agent_id, kind, origin,
        thread_id, reply_to, text, data, state, launched_by_agent_id,
        delivered, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)`,
    [
      values.id,
      values.stream,
      values.authorKind,
      values.author ?? null,
      values.to ?? null,
      values.kind ?? "text",
      values.origin ?? null,
      values.threadId ?? null,
      values.replyTo ?? null,
      values.text ?? "",
      values.data === undefined ? null : JSON.stringify(values.data),
      values.state === undefined ? null : JSON.stringify(values.state),
      values.launchedBy ?? null,
      values.delivered ?? null,
      values.at,
    ]
  );
}

beforeAll(async () => {
  pool = await setupTestDb();
  // Everything up to 0005, then the rows 0004's schema held.
  await runMigrations({ databaseUrl: getTestDatabaseUrl(), count: 4 });
  await pool.query(
    `INSERT INTO agents (id, name, cwd, status, parent_agent_id, launched_by_agent_id)
     VALUES ($1, 'Parent', '/tmp', 'running', NULL, NULL),
            ($2, 'Child', '/tmp', 'running', $1, $1),
            ($3, 'Bare', '/tmp', 'running', $1, $1)`,
    [PARENT, CHILD, BARE]
  );
  // The child: a launch post, then its workspace and system-prompt rows.
  await insert({
    id: ID.launch,
    stream: PARENT,
    authorKind: "user",
    to: CHILD,
    origin: "launch",
    text: "Review the diff",
    launchedBy: PARENT,
    delivered: true,
    at: at(1),
  });
  await insert({
    id: ID.childWorkspace,
    stream: PARENT,
    authorKind: "agent",
    author: CHILD,
    origin: "workspace",
    text: "Workspace ready",
    data: { startup: STARTUP },
    at: at(2),
  });
  await insert({
    id: ID.childPrompt,
    stream: PARENT,
    authorKind: "agent",
    author: CHILD,
    origin: "system_prompt",
    text: "You are the child.",
    at: at(3),
  });
  // An agent launched with no briefing: only its record rows.
  await insert({
    id: ID.bareWorkspace,
    stream: PARENT,
    authorKind: "agent",
    author: BARE,
    origin: "workspace",
    text: "Workspace ready",
    data: { startup: STARTUP },
    at: at(4),
  });
  await insert({
    id: ID.barePrompt,
    stream: PARENT,
    authorKind: "agent",
    author: BARE,
    origin: "system_prompt",
    text: "You are bare.",
    at: at(5),
  });
  // A review request, which is a prompt now and never a row.
  await insert({
    id: ID.request,
    stream: PARENT,
    authorKind: "user",
    to: PARENT,
    origin: "review_request",
    text: "Please launch these personas",
    data: { reviewRequest: { personas: ["code-review"], agentType: "codex" } },
    delivered: true,
    at: at(6),
  });
  // The child's review of the parent's work, with one finding resolved.
  await insert({
    id: ID.review,
    stream: PARENT,
    authorKind: "agent",
    author: CHILD,
    to: PARENT,
    kind: "review",
    text: "",
    data: {
      verdict: "request_changes",
      summary: "Two things.",
      findings: [
        {
          id: "f1",
          severity: "major",
          title: "Guard",
          body: "Null here.",
          path: "a.ts",
          line: 4,
        },
        { id: "f2", severity: "nit", title: "Name", body: "Rename." },
      ],
    },
    state: {
      findings: {
        f1: {
          status: "resolved",
          resolution: "fixed",
          by: { kind: "agent", agentId: PARENT },
          at: "2026-01-01T00:00:20.000Z",
        },
      },
    },
    delivered: true,
    at: at(7),
  });
  // Comments tagged with the finding they are about, and one that is not.
  await insert({
    id: ID.onF1,
    stream: PARENT,
    authorKind: "agent",
    author: PARENT,
    to: CHILD,
    threadId: ID.review,
    replyTo: ID.review,
    text: "Guarded it.",
    data: { findingId: "f1" },
    delivered: true,
    at: at(8),
  });
  await insert({
    id: ID.replyOnF1,
    stream: PARENT,
    authorKind: "agent",
    author: CHILD,
    to: PARENT,
    threadId: ID.review,
    replyTo: ID.onF1,
    text: "Looks right.",
    data: { findingId: "f1" },
    delivered: true,
    at: at(9),
  });
  await insert({
    id: ID.general,
    stream: PARENT,
    authorKind: "user",
    to: CHILD,
    threadId: ID.review,
    replyTo: ID.review,
    text: "Thanks both.",
    delivered: true,
    at: at(10),
  });
  await insert({
    id: ID.askOnF2,
    stream: PARENT,
    authorKind: "agent",
    author: CHILD,
    to: PARENT,
    kind: "question",
    threadId: ID.review,
    replyTo: ID.review,
    text: "Rename to what?",
    data: { options: [{ label: "foo" }], findingId: "f2" },
    state: {},
    delivered: true,
    at: at(11),
  });
  // A text row that carried a startup record alongside its own data.
  await insert({
    id: ID.turn,
    stream: PARENT,
    authorKind: "agent",
    author: PARENT,
    origin: "turn",
    text: "",
    data: { turnEventId: 5, startup: STARTUP },
    at: at(12),
  });
  await runMigrations(getTestDatabaseUrl());
});

afterAll(async () => {
  await teardownTestDb();
});

describe("migration 0005: launch cards and findings", () => {
  it("turns a launch post into the card, with the startup and instructions on it", async () => {
    expect(await row(ID.launch)).toMatchObject({
      kind: "launch",
      origin: null,
      author_kind: "user",
      to_agent_id: CHILD,
      launched_by_agent_id: PARENT,
      thread_id: null,
      text: "Review the diff",
      data: null,
      state: { startup: STARTUP, instructions: "You are the child." },
      delivered: true,
    });
    expect(await row(ID.childWorkspace)).toBeUndefined();
    expect(await row(ID.childPrompt)).toBeUndefined();
  });

  it("makes an agent's earliest record row its card when it had no launch post", async () => {
    expect(await row(ID.bareWorkspace)).toMatchObject({
      kind: "launch",
      origin: null,
      author_kind: "user",
      author_agent_id: null,
      to_agent_id: BARE,
      launched_by_agent_id: PARENT,
      text: "",
      data: null,
      state: { startup: STARTUP, instructions: "You are bare." },
      delivered: true,
    });
    expect(await row(ID.barePrompt)).toBeUndefined();
    const cards = await pool.query<{ to_agent_id: string; n: number }>(
      `SELECT to_agent_id, count(*)::int AS n FROM blocks
        WHERE kind = 'launch' GROUP BY to_agent_id ORDER BY to_agent_id`
    );
    expect(cards.rows).toEqual([
      { to_agent_id: BARE, n: 1 },
      { to_agent_id: CHILD, n: 1 },
    ]);
  });

  it("drops review-request rows and every origin but turn", async () => {
    expect(await row(ID.request)).toBeUndefined();
    const origins = await pool.query<{ origin: string }>(
      `SELECT DISTINCT origin FROM blocks WHERE origin IS NOT NULL`
    );
    expect(origins.rows).toEqual([{ origin: "turn" }]);
    for (const origin of [
      "launch",
      "workspace",
      "system_prompt",
      "review_request",
    ]) {
      await expect(
        pool.query(
          `INSERT INTO blocks (id, stream_id, author_kind, text, origin)
           VALUES (gen_random_uuid(), $1, 'user', 'x', $2)`,
          [PARENT, origin]
        )
      ).rejects.toThrow(/check constraint/i);
    }
    // The new kinds are accepted.
    for (const kind of ["launch", "finding"]) {
      await pool.query(
        `INSERT INTO blocks (id, stream_id, author_kind, text, kind)
         VALUES (gen_random_uuid(), 'agt_mig_scratch', 'user', 'x', $1)`,
        [kind]
      );
    }
    await pool.query(`DELETE FROM blocks WHERE stream_id = 'agt_mig_scratch'`);
  });

  it("turns a review's findings into finding blocks the review shows, keeping their records", async () => {
    const findings = await pool.query<Row>(
      `SELECT * FROM blocks WHERE kind = 'finding' AND thread_id = $1
        ORDER BY created_at, id`,
      [ID.review]
    );
    expect(findings.rows).toHaveLength(2);
    const [f1, f2] = findings.rows;
    expect(f1).toMatchObject({
      author_kind: "agent",
      author_agent_id: CHILD,
      to_agent_id: PARENT,
      reply_to: ID.review,
      data: {
        severity: "major",
        title: "Guard",
        body: "Null here.",
        path: "a.ts",
        line: 4,
      },
      state: {
        status: "resolved",
        resolution: "fixed",
        by: { kind: "agent", agentId: PARENT },
        at: "2026-01-01T00:00:20.000Z",
      },
      delivered: true,
    });
    expect(f1!.data).not.toHaveProperty("id");
    // A finding with no record starts open.
    expect(f2).toMatchObject({
      data: { severity: "nit", title: "Name", body: "Rename." },
      state: { status: "open", by: { kind: "user" } },
    });
    expect(await row(ID.review)).toMatchObject({
      kind: "review",
      data: { summary: "Two things." },
      state: { blocks: [f1!.id, f2!.id] },
    });
  });

  it("moves each finding's comments into the finding's own thread", async () => {
    const findings = await pool.query<{ id: string }>(
      `SELECT id FROM blocks WHERE kind = 'finding' AND thread_id = $1
        ORDER BY created_at, id`,
      [ID.review]
    );
    const [f1, f2] = findings.rows.map((r) => r.id);
    // A comment on the review about f1 now replies to f1 itself; a reply to
    // that comment keeps its parent.
    expect(await row(ID.onF1)).toMatchObject({
      thread_id: f1,
      reply_to: f1,
      data: null,
    });
    expect(await row(ID.replyOnF1)).toMatchObject({
      thread_id: f1,
      reply_to: ID.onF1,
      data: null,
    });
    // A question about f2 keeps its own data, without the tag.
    expect(await row(ID.askOnF2)).toMatchObject({
      thread_id: f2,
      reply_to: f2,
      data: { options: [{ label: "foo" }] },
    });
    // A comment about no finding stays in the review's thread.
    expect(await row(ID.general)).toMatchObject({
      thread_id: ID.review,
      reply_to: ID.review,
      data: null,
    });
    const tagged = await pool.query(
      `SELECT id FROM blocks WHERE data ? 'findingId'`
    );
    expect(tagged.rows).toEqual([]);
  });

  it("strips startup records off text rows, keeping the rest of their data", async () => {
    expect(await row(ID.turn)).toMatchObject({
      origin: "turn",
      data: { turnEventId: 5 },
    });
  });
});
