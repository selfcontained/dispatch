/**
 * T16: `set_workspace` for a local agent goes through `workspace.select` on
 * the local runner child. The child here is the real socket server, core
 * handlers, binding store and workload, in this process, attached to a real
 * manager over a real database. Every move must land on the row exactly as
 * main's in-process resolution does, be recorded in the child's binding
 * (never as a checkout it owns), and leave archive deciding by the launch
 * worktree alone.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
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

const cleanupGitWorktreeSpy = vi.fn(async () => ({
  repoRoot: "/tmp/repo",
  worktreePath: "/tmp/repo-wt",
  worktreeName: "repo-wt",
  branchName: null,
  baseBranch: "main",
  updatedBaseBranch: false,
  deletedBranch: false,
}));

vi.mock("../../src/shared/git/worktree.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/shared/git/worktree.js")
  >("../../src/shared/git/worktree.js");
  return { ...actual, cleanupGitWorktree: cleanupGitWorktreeSpy };
});

const { AgentManager } = await import("../../src/agents/manager.js");
const { resolveWorkspace } = await import("../helpers/main-workspace.js");
const { checkoutWorkload, workspaceWorkload } =
  await import("../helpers/checkout-workload.js");

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

const inertConfig = {
  host: "127.0.0.1",
  port: 6767,
  databaseUrl: "",
  authToken: "test-token",
  filesRoot: "/tmp/dispatch-test-files",
  dispatchBinDir: "/tmp",
  codexBin: "echo",
  claudeBin: "echo",
  opencodeBin: "echo",
  agentRuntime: "inert",
  tls: null,
} satisfies import("../../src/config.js").AppConfig;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
    stdio: "ignore",
  });
}

let pool: Pool;
let manager: InstanceType<typeof AgentManager>;
let store: BindingStore;
let fence: WriteFence;
let session: LocalRunnerSession;
let socket: { close(): void };
let childRuns: string[] = [];
let root: string;
let repo: string;
let launchWorktree: string;
let ownWorktree: string;
let otherRepo: string;
let plainDir: string;
let socketDir: string;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();

  root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "dispatch-workspace-child-"))
  );
  repo = path.join(root, "repo");
  await mkdir(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  launchWorktree = path.join(root, "launch-wt");
  git(repo, "worktree", "add", "-q", "-b", "agt/launch", launchWorktree);
  ownWorktree = path.join(root, "own-wt");
  git(repo, "worktree", "add", "-q", "-b", "agt/own", ownWorktree);
  otherRepo = path.join(root, "other");
  await mkdir(path.join(otherRepo, "src"), { recursive: true });
  git(otherRepo, "init", "-q", "-b", "master");
  git(otherRepo, "commit", "-q", "--allow-empty", "-m", "init");
  git(otherRepo, "checkout", "-q", "-b", "fix/wrong-repo");
  plainDir = path.join(root, "plain");
  await mkdir(plainDir);
  await writeFile(path.join(root, "file.txt"), "x\n");

  const state = path.join(root, "state");
  await mkdir(state);
  store = new BindingStore(state);
  fence = new WriteFence(false);
  const platform = {
    workload: {
      run: ((...args: Parameters<typeof checkoutWorkload.run>) => {
        childRuns.push(args[0]);
        return checkoutWorkload.run(...args);
      }) as typeof checkoutWorkload.run,
    },
    workspace: workspaceWorkload,
  };
  socketDir = await mkdtemp(path.join("/tmp", "ws-child-"));
  const socketPath = path.join(socketDir, "s");
  const nonce = randomUUID();
  socket = await serveSocket(
    socketPath,
    nonce,
    {
      calls: {
        ...checkoutHandlers(store, platform),
        ...workspaceHandlers(state, store, workspaceWorkload),
      },
    },
    fence
  );
  session = new LocalRunnerSession({
    description: {
      runnerId: runnerIdFromWire("local"),
      displayName: "Local",
      build: { version: "test" },
      protocol: 1,
      engines: [],
      capabilities: {},
    },
  });
  session.setEndpoint({ socket: socketPath, nonce });
  manager = new AgentManager(pool, noopLogger, inertConfig);
  manager.attachLocalRunner(() => session);
});

afterAll(async () => {
  session?.close();
  socket?.close();
  await teardownTestDb();
  await rm(root, { recursive: true, force: true });
  await rm(socketDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await pool.query("DELETE FROM agents");
  cleanupGitWorktreeSpy.mockClear();
  childRuns = [];
});

/** A worktree agent bound by the child as the app's import binds it. */
async function launch(id: string, worktreePath = launchWorktree) {
  const branch = worktreePath === launchWorktree ? "agt/launch" : "agt/own";
  await pool.query(
    `INSERT INTO agents (id, name, status, cwd, launch_cwd, worktree_path, worktree_branch, base_branch)
     VALUES ($1, $1, 'stopped', $2, $3, $2, $4, 'main')`,
    [id, worktreePath, repo, branch]
  );
  await store.import([
    {
      session: id,
      path: worktreePath,
      currentPath: null,
      worktree: { path: worktreePath, branch, base: "main" },
    },
  ]);
  await manager.populateGitContext(id);
}

async function archive(id: string): Promise<void> {
  await manager.beginArchive(id, "force");
  await new Promise<void>((resolve, reject) => {
    void manager.executeArchive(id, {
      onPhaseChange: () => {},
      onComplete: () => resolve(),
      onError: (err) => reject(err),
    });
  });
}

/** The outcome of a move as main computes it in process, or its refusal. */
async function mainOutcome(
  id: string,
  input: { path: string | null; baseBranch?: string | null }
) {
  const agent = (await manager.getAgent(id))!;
  return resolveWorkspace(agent, input).then(
    (value) => ({ value }),
    (error: Error & { statusCode?: number }) => ({
      error: { message: error.message, statusCode: error.statusCode },
    })
  );
}

async function childOutcome(
  id: string,
  input: { path: string | null; baseBranch?: string | null }
) {
  return manager.setWorkspace(id, input).then(
    (agent) => ({
      value: {
        path: agent.workspacePath,
        baseBranch: agent.workspaceBaseBranch,
      },
    }),
    (error: Error & { statusCode?: number }) => ({
      error: { message: error.message, statusCode: error.statusCode },
    })
  );
}

describe("set_workspace through the local runner child", () => {
  const moves: Array<
    [string, () => { path: string | null; baseBranch?: string }]
  > = [
    ["another repo", () => ({ path: otherRepo })],
    [
      "a subdirectory of another repo",
      () => ({ path: path.join(otherRepo, "src") }),
    ],
    ["a worktree of the same repo", () => ({ path: ownWorktree })],
    ["a folder outside Git", () => ({ path: plainDir })],
    ["an explicit base", () => ({ path: otherRepo, baseBranch: "release" })],
    ["the launch worktree", () => ({ path: launchWorktree })],
    [
      "the launch worktree with a base",
      () => ({ path: launchWorktree, baseBranch: "agt/launch" }),
    ],
    ["back to launch", () => ({ path: null })],
    ["a missing path", () => ({ path: path.join(root, "missing") })],
    ["a file", () => ({ path: path.join(root, "file.txt") })],
    ["a relative path", () => ({ path: "relative/dir" })],
    ["a flag-like base", () => ({ path: otherRepo, baseBranch: "--all" })],
  ];

  it.each(moves)(
    "%s lands on the row as main resolves it",
    async (_, input) => {
      const id = `agt_m_${randomUUID().slice(0, 8)}`;
      await launch(id);
      const expected = await mainOutcome(id, input());
      expect(await childOutcome(id, input())).toEqual(expected);
    }
  );

  it("records the move in the child's binding, and the child serves the agent there", async () => {
    await launch("agt_a");
    const launched = await store.get("agt_a");

    const moved = await manager.setWorkspace("agt_a", { path: otherRepo });
    expect(moved).toMatchObject({
      cwd: launchWorktree,
      worktreePath: launchWorktree,
      workspacePath: otherRepo,
      workspaceBaseBranch: "master",
      gitContext: { repoRoot: otherRepo, branch: "fix/wrong-repo" },
    });
    // Only the current folder changes: the checkout stays owned, as launched.
    expect(await store.get("agt_a")).toEqual({
      ...launched,
      currentPath: otherRepo,
    });
    expect(childRuns).toContain("git.context");

    // Reads after the move are the child's, at the new folder.
    childRuns = [];
    const listing = (await manager.viewCheckout(moved, {
      kind: "directory",
      path: "",
    })) as { entries?: Array<{ name: string }> };
    expect(childRuns).toEqual(["checkout.list"]);
    expect(JSON.stringify(listing)).toContain("src");

    const back = await manager.setWorkspace("agt_a", { path: null });
    expect(back.workspacePath).toBeNull();
    expect(back.gitContext).toMatchObject({
      worktreePath: launchWorktree,
      branch: "agt/launch",
    });
    expect(await store.get("agt_a")).toEqual(launched);
  });

  it("is refused by a frozen child and leaves the row and binding as they were", async () => {
    await launch("agt_f");
    await fence.freeze();
    try {
      await expect(
        manager.setWorkspace("agt_f", { path: otherRepo })
      ).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      fence.thaw();
    }
    expect((await manager.getAgent("agt_f"))?.workspacePath).toBeNull();
    expect((await store.get("agt_f"))?.currentPath).toBeNull();
  });
});

describe("archive of an agent moved through the child", () => {
  it("removes the launch worktree only, never the folder it moved into", async () => {
    await launch("agt_a");
    await manager.setWorkspace("agt_a", { path: ownWorktree });
    expect((await store.get("agt_a"))?.checkout).toMatchObject({
      path: launchWorktree,
      ownership: "owned",
    });

    await archive("agt_a");

    const cleaned = cleanupGitWorktreeSpy.mock.calls.map(
      (call) => (call as unknown as [{ cwd: string }])[0].cwd
    );
    expect(cleaned).toEqual([launchWorktree]);
    expect(await store.get("agt_a")).toBeNull();
  });

  it("spares a worktree another live agent moved into", async () => {
    await launch("agt_owner", ownWorktree);
    await launch("agt_mover");
    await manager.setWorkspace("agt_mover", { path: ownWorktree });

    await archive("agt_owner");

    expect(cleanupGitWorktreeSpy).not.toHaveBeenCalled();
    expect(await store.get("agt_owner")).toMatchObject({
      checkout: { path: ownWorktree, ownership: "owned" },
    });
  });
});
