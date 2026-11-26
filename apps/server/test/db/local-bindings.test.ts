/*
 * Agent rows → the import query → a real local runner child → stored
 * ownership, on a scratch database and temp Git repositories. Covers the
 * row filter (deleted, other runners, a pending archive) and the whole
 * chain for each local acceptance case.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  superviseRunner,
  type LaunchedRunner,
  type RunnerSupervisor,
} from "@dispatch/runner-client/launcher";
import { readLocalBindings } from "../../src/runners/local-bindings.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./setup.js";

const entry = fileURLToPath(
  new URL(
    "../../../../packages/runner/test/fixtures/runner-entry.ts",
    import.meta.url
  )
);
const build = { version: "0.0.0-test" };

let pool: Pool;
let work: string;
let supervisor: RunnerSupervisor | undefined;

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
    { cwd, stdio: "ignore" }
  );

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  work = realpathSync(mkdtempSync(join(tmpdir(), "local-bindings-db-")));
});

afterAll(async () => {
  await supervisor?.stop(2_000);
  rmSync(work, { recursive: true, force: true });
  await teardownTestDb();
});

async function insert(id: string, values: Record<string, string>, extra = "") {
  const row = { status: "stopped", ...values };
  const columns = ["id", "name", ...Object.keys(row)];
  await pool.query(
    `INSERT INTO agents (${columns.join(", ")})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
    [id, id, ...Object.values(row)]
  );
  if (extra) await pool.query(extra, [id]);
}

it("imports each live local row once with main's ownership, and no other row", async () => {
  const repo = join(work, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const wt = (name: string) => join(work, name);
  for (const name of ["created", "moved", "deleted", "switched", "archiving"])
    git(repo, "worktree", "add", "-q", "-b", name, wt(name));
  git(wt("switched"), "checkout", "-q", "-b", "later");
  rmSync(wt("deleted"), { recursive: true, force: true });
  mkdirSync(join(work, "plain"));
  mkdirSync(join(work, "elsewhere"));

  const worktreeRow = (name: string) => ({
    cwd: wt(name),
    worktree_path: wt(name),
    worktree_branch: name,
    base_branch: "main",
  });
  await insert("created", worktreeRow("created"));
  await insert("plain", { cwd: join(work, "plain") });
  await insert("moved", {
    ...worktreeRow("moved"),
    workspace_path: join(work, "elsewhere"),
  });
  await insert("deleted", worktreeRow("deleted"));
  await insert("switched", worktreeRow("switched"));
  await insert(
    "archiving",
    { ...worktreeRow("archiving"), status: "archiving" },
    "UPDATE agents SET archive_phase = 'stopping', archive_cleanup_mode = 'force' WHERE id = $1"
  );
  // A reviewer whose cwd is another session's worktree.
  await insert("reviewer", { cwd: wt("created") });
  // Not imported: archived and another runner.
  await insert(
    "gone-row",
    worktreeRow("created"),
    "UPDATE agents SET deleted_at = NOW() WHERE id = $1"
  );
  await insert(
    "remote",
    { cwd: "/srv/checkout", worktree_path: "/srv/checkout" },
    "UPDATE agents SET runner_id = 'rnr_other' WHERE id = $1"
  );

  const bindings = await readLocalBindings(pool);
  expect(bindings.map((b) => b.session).sort()).toEqual(
    [
      "archiving",
      "created",
      "deleted",
      "moved",
      "plain",
      "reviewer",
      "switched",
    ].sort()
  );

  const state = join(work, "state");
  const runner = await new Promise<LaunchedRunner>((resolve) => {
    supervisor = superviseRunner({
      command: [process.env.BUN_BINARY ?? "bun", entry, "local-runner"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        RUNNER_TEST_BUILD: JSON.stringify(build),
      },
      start: {
        build,
        roots: { state, files: state },
        config: { runnerId: "local", displayName: "Local", engines: [] },
      },
      onState: (s) => s.state === "ready" && resolve(s.runner),
    });
  });
  expect(await runner.importBindings(bindings, 10_000)).toMatchObject({
    added: 7,
    kept: 0,
    invalid: 0,
    frozen: false,
  });
  // The next start sends the same list: nothing changes.
  expect(
    await runner.importBindings(await readLocalBindings(pool), 10_000)
  ).toMatchObject({ added: 0, kept: 7 });

  const stored = (session: string) => {
    const file = join(
      state,
      ".bindings",
      `${createHash("sha256").update(session).digest("hex")}.json`
    );
    return existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as {
          currentPath: string | null;
          checkout: { ownership: string; branch: string | null };
        })
      : null;
  };
  expect(stored("created")?.checkout.ownership).toBe("owned");
  expect(stored("plain")?.checkout.ownership).toBe("external");
  expect(stored("moved")?.checkout.ownership).toBe("owned");
  expect(stored("moved")?.currentPath).toBe(join(work, "elsewhere"));
  expect(stored("deleted")?.checkout.ownership).toBe("gone");
  expect(stored("switched")?.checkout).toMatchObject({
    ownership: "owned",
    branch: "switched",
  });
  expect(stored("archiving")?.checkout.ownership).toBe("owned");
  expect(stored("reviewer")?.checkout.ownership).toBe("external");
  for (const absent of ["gone-row", "remote", "locator"])
    expect(stored(absent)).toBeNull();
});
