/**
 * A local launch that asked for its own worktree, interrupted by an app
 * restart before the worktree existed, then started again: Start finishes
 * that same checkout (same path, branch and base) in the local runner child.
 * A launch that asked for none is a direct launch, and stays one after the
 * restart. The child is the real socket server, core handlers, binding store
 * and `posix-user` workload in this process; the database is real.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import type { Pool } from "pg";
import { runnerIdFromWire } from "@dispatch/runner-protocol/contract";
import { LocalRunnerSession } from "@dispatch/runner-client/session";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./setup.js";
import { serveSocket } from "../../../../packages/runner/src/local/socket-server.js";
import { BindingStore } from "../../../../packages/runner/src/local/bindings.js";
import { WriteFence } from "../../../../packages/runner/src/local/fence.js";
import { checkoutHandlers } from "../../../../packages/runner/src/core/checkout.js";
import { workspaceHandlers } from "../../../../packages/runner/src/core/workspace.js";
import { createInertRuntime } from "../../src/agents/runtime.js";
import type { AgentRuntime } from "../../src/agents/runtime.js";

const { AgentManager } = await import("../../src/agents/manager.js");
const { checkoutWorkload, workspaceWorkload } =
  await import("../../src/agents/checkout-worker.js");

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

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
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
}

let pool: Pool;
let root: string;
let repo: string;
let state: string;
let socketDir: string;
let socketPath: string;
let nonce: string;
let socket: { close(): void };
const sessions: LocalRunnerSession[] = [];

function config() {
  return {
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
  } satisfies import("../../src/config.js").AppConfig;
}

function runtime(): AgentRuntime {
  return {
    ...createInertRuntime(),
    tracksProcesses: () => true,
    launch: vi.fn(async () => ({ sessionId: "sess", resumed: false })),
    attach: vi.fn(async () => false),
    isAlive: vi.fn(async () => false),
  } as AgentRuntime;
}

/** A session to the child; `connected: false` is a child that never comes up. */
function child(connected: boolean) {
  const session = new LocalRunnerSession({
    description: {
      runnerId: runnerIdFromWire("local"),
      displayName: "Local",
      build: { version: "test" },
      protocol: 1,
      engines: [],
      capabilities: {},
    },
  });
  if (connected) session.setEndpoint({ socket: socketPath, nonce });
  sessions.push(session);
  return session;
}

/** An app instance on the shared database, state root and child. */
function app(connected: boolean) {
  const manager = new AgentManager(pool, noopLogger, config(), {
    runtime: runtime(),
  });
  const session = child(connected);
  manager.attachLocalRunner(() => session);
  return manager;
}

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "dispatch-worktree-restart-"))
  );
  state = path.join(root, "state");
  await mkdir(state);
  await mkdir(path.join(root, "files"));
  const store = new BindingStore(state);
  socketDir = await mkdtemp(path.join("/tmp", "wt-restart-"));
  socketPath = path.join(socketDir, "s");
  nonce = randomUUID();
  socket = await serveSocket(
    socketPath,
    nonce,
    {
      calls: {
        ...checkoutHandlers(store, {
          workload: checkoutWorkload,
          workspace: workspaceWorkload,
        }),
        ...workspaceHandlers(state, store, workspaceWorkload),
      },
    },
    new WriteFence(false)
  );
});

afterAll(async () => {
  for (const session of sessions) session.close();
  socket?.close();
  await teardownTestDb();
  await rm(root, { recursive: true, force: true });
  await rm(socketDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await pool.query("DELETE FROM agents");
  repo = path.join(root, `repo-${randomUUID().slice(0, 8)}`);
  await mkdir(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
});

afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
});

/** The row as Start left it. */
async function row(id: string) {
  return (
    await pool.query<{
      cwd: string;
      worktree_path: string | null;
      worktree_branch: string | null;
      base_branch: string | null;
      status: string;
    }>(
      "SELECT cwd, worktree_path, worktree_branch, base_branch, status FROM agents WHERE id = $1",
      [id]
    )
  ).rows[0]!;
}

it("finishes the worktree an interrupted create asked for, on Start after a restart", async () => {
  // The child never answers this instance: the app dies before the
  // worktree exists.
  const before = app(false);
  const created = await before.createAgent(
    {
      cwd: repo,
      name: "Resume me",
      useWorktree: true,
      createNewBranch: true,
      baseBranch: "main",
    },
    { detachLaunch: true }
  );
  expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(
    "resume-me"
  );

  // Restarted: the row is restored as stopped, then started.
  const after = app(true);
  await after.restoreRunningAgents();
  expect((await row(created.id)).status).toBe("stopped");
  await after.startAgent(created.id);

  const started = await row(created.id);
  expect(started.worktree_path).toBeTruthy();
  expect(started.worktree_path).not.toBe(repo);
  expect(started.worktree_branch).toBe(
    git(started.worktree_path!, "branch", "--show-current")
  );
  expect(started.base_branch).toBe("main");
  expect(git(repo, "worktree", "list", "--porcelain")).toContain(
    `worktree ${started.worktree_path}`
  );
  // Started again: the same checkout, no second worktree.
  await after.stopAgent(created.id);
  await after.startAgent(created.id);
  expect(await row(created.id)).toMatchObject({
    worktree_path: started.worktree_path,
    worktree_branch: started.worktree_branch,
    base_branch: "main",
  });
  expect(
    git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)
  ).toHaveLength(2);
});

it("keeps a direct launch direct across a restart", async () => {
  const before = app(true);
  const created = await before.createAgent(
    { cwd: repo, name: "Direct", useWorktree: false },
    { detachLaunch: true }
  );
  const after = app(true);
  await after.restoreRunningAgents();
  await after.startAgent(created.id);
  expect(await row(created.id)).toMatchObject({
    cwd: repo,
    worktree_path: null,
  });
  expect(
    git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)
  ).toHaveLength(1);
});
