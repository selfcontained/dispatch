/*
 * Main's co-owner rule for a local row: another live agent that references
 * the worktree keeps it on disk. The branch's rule (through the agent's
 * runner for the real spelling) answers as origin/main's own query does,
 * at the spelling the row was created under and at the real path.
 */
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  localCoOwner,
  observedCoOwner,
} from "../../src/agents/archive-policy.js";
import { runnerDirectory } from "../../src/runners/directory.js";
import { controllerPlacement } from "../../src/runners/placement.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./setup.js";

let pool: Pool;
let root: string;
let real: string;
let link: string;

/** origin/main's query, verbatim, with its two spellings. */
async function mainCoOwner(agent: {
  id: string;
  worktreePath: string;
  worktreeBranch: string | null;
}) {
  const spellings = [
    ...new Set([
      agent.worktreePath,
      await realpath(agent.worktreePath).catch(() => agent.worktreePath),
    ]),
  ];
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id
     FROM agents
     WHERE deleted_at IS NULL
       AND id <> $1
       AND (worktree_path = $2
            OR workspace_path = ANY($4::text[])
            OR (role = 'review' AND cwd = ANY($4::text[]))
            OR ($3::text IS NOT NULL AND worktree_branch = $3))
     LIMIT 1`,
    [agent.id, agent.worktreePath, agent.worktreeBranch, spellings]
  );
  return rows[0]?.id ?? null;
}

const owner = () => ({
  id: "agt_owner",
  cwd: real,
  worktreePath: link,
  worktreeBranch: "owner-branch",
  baseBranch: "main",
});

async function other(columns: Record<string, string | null>) {
  const row: Record<string, string | null> = {
    id: "agt_other",
    name: "other",
    status: "running",
    cwd: root,
    role: "standard",
    ...columns,
  };
  const keys = Object.keys(row);
  await pool.query(
    `INSERT INTO agents (${keys.join(", ")}) VALUES (${keys
      .map((_, i) => `$${i + 1}`)
      .join(", ")})`,
    Object.values(row)
  );
}

const local = () => runnerDirectory({}).for(controllerPlacement);

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  root = await realpath(await mkdtemp(path.join(tmpdir(), "co-owner-")));
  real = path.join(root, "worktree");
  await mkdir(real);
  link = path.join(root, "link");
  await symlink(real, link);
}, 60_000);

afterAll(async () => {
  await teardownTestDb();
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await pool.query("DELETE FROM agents");
  await pool.query(
    `INSERT INTO agents (id, name, status, cwd, worktree_path, worktree_branch, base_branch)
     VALUES ('agt_owner', 'owner', 'archiving', $1, $2, 'owner-branch', 'main')`,
    [real, link]
  );
});

describe("a local row's co-owner, as main decides it", () => {
  it.each([
    ["the same recorded worktree", () => ({ worktree_path: link })],
    [
      "a moved workspace at the created spelling",
      () => ({ workspace_path: link }),
    ],
    ["a moved workspace at the real path", () => ({ workspace_path: real })],
    [
      "a reviewer in it at the real path",
      () => ({ role: "review", cwd: real }),
    ],
    [
      "a reviewer in it at the created spelling",
      () => ({ role: "review", cwd: link }),
    ],
    ["the same branch", () => ({ worktree_branch: "owner-branch" })],
    ["nothing shared", () => ({ cwd: root })],
  ])("%s", async (_, columns) => {
    await other(columns());
    expect(await localCoOwner(pool, owner(), local())).toBe(
      await mainCoOwner(owner())
    );
  });

  it("ignores an archived agent, as main does", async () => {
    await other({ workspace_path: real });
    await pool.query(
      "UPDATE agents SET deleted_at = NOW() WHERE id = 'agt_other'"
    );
    expect(await mainCoOwner(owner())).toBeNull();
    expect(await localCoOwner(pool, owner(), local())).toBeNull();
  });
});

it("treats identical paths on another runner as a different checkout", async () => {
  await other({
    cwd: real,
    worktree_path: link,
    worktree_branch: "owner-branch",
    runner_id: "runner-other",
  });
  expect(await localCoOwner(pool, owner(), local())).toBeNull();
});

describe("the common observed policy preserves live users of a checkout", () => {
  const observation = () => ({
    ownership: "owned" as const,
    owner: "agt_owner",
    borrowers: [] as string[],
    checkout: {
      path: real,
      branch: "owner-branch",
      stateId: "0".repeat(64),
      unmerged: false,
      changedFiles: [],
      uncommittedFiles: [],
    },
  });
  it.each(["standard", "review"])(
    "protects a moved workspace for a %s agent",
    async (role) => {
      await other({ role, workspace_path: real });
      expect(await observedCoOwner(pool, owner(), observation())).toBe(
        "agt_other"
      );
    }
  );
  it("protects persisted checkout-owner links independently of cwd", async () => {
    await other({ runner_worktree_owner: "agt_owner" });
    expect(
      await observedCoOwner(pool, owner(), { ...observation(), checkout: null })
    ).toBe("agt_other");
  });
  it("honours the runner's borrower list for every role", async () => {
    await other({ role: "standard" });
    expect(
      await observedCoOwner(pool, owner(), {
        ...observation(),
        borrowers: ["agt_other"],
      })
    ).toBe("agt_other");
  });
  it("does not hold a checkout for an archived borrower", async () => {
    await other({ workspace_path: real });
    await pool.query("UPDATE agents SET deleted_at=NOW() WHERE id='agt_other'");
    expect(await observedCoOwner(pool, owner(), observation())).toBeNull();
  });
  it("does not treat a matching folder on another runner as a hold", async () => {
    await other({ workspace_path: real, runner_id: "runner-other" });
    expect(await observedCoOwner(pool, owner(), observation())).toBeNull();
  });
});
