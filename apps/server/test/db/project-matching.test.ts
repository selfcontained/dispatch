/**
 * Which project an unscoped local launch joins, as origin/main decides it
 * (`projects/matching.ts`, `resolveProjectRoot`): no projects, no Git; with
 * projects, the folder's project root (a linked worktree's is its primary
 * checkout) and each project root's `realpath`, a stale root skipped; a
 * root equal to the folder's, or the folder under a root, matches; two
 * matches are refused with both names; a Git failure other than "not a git
 * repository" escapes as Git's own error. The branch also matches a
 * project's extra roots (migration 0066). The database is real.
 */
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./setup.js";
import {
  createInertRuntime,
  type AgentRuntime,
} from "../../src/agents/runtime.js";
import { AgentError } from "../../src/agents/errors.js";
import { handleAgentError } from "../../src/server/http-helpers.js";

const { AgentManager } = await import("../../src/agents/manager.js");

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => noopLogger,
  silent: () => {},
  level: "silent",
} as unknown as import("fastify").FastifyBaseLogger;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

let pool: Pool;
let root: string;
let repo: string;
let manager: InstanceType<typeof AgentManager>;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "matching-")));
  repo = path.join(root, "repo");
  await mkdir(path.join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  git(repo, "worktree", "add", "-q", "-b", "wt", path.join(root, "linked"));
  await mkdir(path.join(root, "extra"));
  await mkdir(path.join(root, "elsewhere"));
  await symlink(repo, path.join(root, "repo-link"));
  // Git fails for this folder with something other than "not a repository".
  const broken = path.join(root, "broken");
  await mkdir(broken);
  git(broken, "init", "-q");
  await writeFile(path.join(broken, ".git", "config"), "[core\nbad");
  const state = path.join(root, "state");
  await mkdir(state);
  manager = new AgentManager(
    pool,
    noopLogger,
    {
      host: "127.0.0.1",
      port: 6767,
      databaseUrl: "",
      authToken: "test-token",
      filesRoot: path.join(root, "files"),
      agentStateRoot: state,
      dispatchBinDir: "/tmp",
      codexBin: "echo",
      claudeBin: "echo",
      opencodeBin: "echo",
      agentRuntime: "inert",
      tls: null,
    },
    {
      runtime: {
        ...createInertRuntime(),
        launch: vi.fn(async () => ({ sessionId: "s", resumed: false })),
      } as AgentRuntime,
    }
  );
});

afterAll(async () => {
  await teardownTestDb();
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await pool.query("DELETE FROM agents");
  await pool.query("DELETE FROM projects");
});

async function project(
  id: string,
  repoRoot: string,
  extraRoots: string[] = []
) {
  await pool.query(
    "INSERT INTO projects (id, name, repo_root, extra_roots) VALUES ($1, $2, $3, $4)",
    [id, `Project ${id}`, repoRoot, extraRoots]
  );
}

const launch = (cwd: string) =>
  manager.createAgent({ cwd, useWorktree: false }, { detachLaunch: true });

it("joins no project when there are none, even where Git fails", async () => {
  expect((await launch(repo)).projectId).toBeNull();
  expect((await launch(path.join(root, "broken"))).projectId).toBeNull();
});

it.each([
  ["the root", () => repo],
  ["a subdirectory", () => path.join(repo, "src")],
  ["a linked worktree", () => path.join(root, "linked")],
  ["a symlink to the root", () => path.join(root, "repo-link")],
])("matches a project by %s", async (_name, cwd) => {
  await project("p1", repo);
  await project("other", path.join(root, "elsewhere"));
  expect((await launch(cwd())).projectId).toBe("p1");
});

it("matches a project registered through a symlink, and by an extra root", async () => {
  await project("linked-root", path.join(root, "repo-link"));
  await project("extra", path.join(root, "elsewhere"), [
    path.join(root, "extra"),
  ]);
  expect((await launch(repo)).projectId).toBe("linked-root");
  expect((await launch(path.join(root, "extra"))).projectId).toBe("extra");
});

it("skips a project root that no longer exists", async () => {
  await project("stale", path.join(root, "gone"));
  await project("p1", repo);
  expect((await launch(repo)).projectId).toBe("p1");
});

it("joins none when no project holds the folder", async () => {
  await project("p1", repo);
  expect((await launch(path.join(root, "elsewhere"))).projectId).toBeNull();
});

it("refuses two matches with both names", async () => {
  await project("a", repo);
  await project("b", path.join(root, "repo-link"));
  await expect(launch(repo)).rejects.toMatchObject({
    statusCode: 409,
    message:
      "Multiple projects match this directory. Choose a project: Project a (a), Project b (b).",
  });
});

it("fails with Git's own error when Git fails for the folder and projects exist", async () => {
  await project("p1", repo);
  const broken = path.join(root, "broken");
  const failure = await launch(broken).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(AgentError);
  expect((failure as Error).message).toMatch(
    new RegExp(
      `^Command failed: git -C ${broken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} rev-parse --path-format=absolute --git-common-dir\\n.*bad config`,
      "s"
    )
  );
});

it("answers the create route with main's 500 and Git's message, nothing else", async () => {
  await project("p1", repo);
  const broken = path.join(root, "broken");
  const failure = await launch(broken).catch((error: unknown) => error);
  const sent: { status?: number; body?: unknown } = {};
  const reply = {
    code(status: number) {
      sent.status = status;
      return reply;
    },
    send(body: unknown) {
      sent.body = body;
      return reply;
    },
  };
  handleAgentError(reply as never, failure);
  expect(sent).toEqual({
    status: 500,
    body: { error: (failure as Error).message },
  });
});

it("answers main's 400s before any Git, with projects present", async () => {
  await project("p1", repo);
  await expect(launch(path.join(root, "missing"))).rejects.toMatchObject({
    statusCode: 400,
    message: "Working directory does not exist or is not a directory.",
  });
  await expect(launch("relative/dir")).rejects.toMatchObject({
    statusCode: 400,
    message: "Working directory must be an absolute path.",
  });
});

it("treats a folder outside Git as its own root, with projects present", async () => {
  await project("plain", path.join(root, "elsewhere"));
  expect((await launch(path.join(root, "elsewhere"))).projectId).toBe("plain");
});
