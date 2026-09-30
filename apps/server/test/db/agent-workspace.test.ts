/**
 * An agent that moves after launch (its own worktree, another repo) reports a
 * workspace. These run real git against temp repos and a real database: the
 * row, git_context and archive cleanup must all agree on what moved and what
 * Dispatch still owns.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
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

import { runTestMigrations, setupTestDb, teardownTestDb } from "./setup.js";

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

// Lets a test hold one directory's git probe open to reorder it against a
// workspace change.
const probeGates = new Map<string, Promise<void>>();
vi.mock("../../src/shared/git/git-context.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/shared/git/git-context.js")
  >("../../src/shared/git/git-context.js");
  return {
    ...actual,
    probeGitContext: async (
      cwd: string,
      opts?: Parameters<typeof actual.probeGitContext>[1]
    ) => {
      const result = await actual.probeGitContext(cwd, opts);
      const gate = probeGates.get(cwd);
      if (gate) {
        probeGates.delete(cwd);
        await gate;
      }
      return result;
    },
  };
});

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
let root: string;
let repo: string;
let launchWorktree: string;
let ownWorktree: string;
let otherRepo: string;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  manager = new AgentManager(pool, noopLogger, inertConfig);

  root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "dispatch-agent-workspace-"))
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
  await mkdir(otherRepo);
  git(otherRepo, "init", "-q", "-b", "main");
  git(otherRepo, "commit", "-q", "--allow-empty", "-m", "init");
  git(otherRepo, "checkout", "-q", "-b", "fix/wrong-repo");
});

afterAll(async () => {
  await teardownTestDb();
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await pool.query("DELETE FROM agents");
  cleanupGitWorktreeSpy.mockClear();
});

async function insertWorktreeAgent(
  id: string,
  worktreePath: string,
  branch: string
): Promise<void> {
  await pool.query(
    `INSERT INTO agents (id, name, status, cwd, launch_cwd, worktree_path, worktree_branch, base_branch)
     VALUES ($1, $1, 'stopped', $2, $3, $2, $4, 'main')`,
    [id, worktreePath, repo, branch]
  );
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

describe("setWorkspace", () => {
  it("follows the agent into another repo and back", async () => {
    await insertWorktreeAgent("agt_a", launchWorktree, "agt/launch");
    const published: string[] = [];
    manager.onAgentUpdated((agent) => {
      if (agent.id === "agt_a") published.push(agent.workspacePath ?? "home");
    });

    const moved = await manager.setWorkspace("agt_a", { path: otherRepo });
    expect(moved).toMatchObject({
      cwd: launchWorktree,
      worktreePath: launchWorktree,
      worktreeBranch: "agt/launch",
      workspacePath: otherRepo,
      workspaceBaseBranch: "main",
    });
    expect(moved.gitContext).toMatchObject({
      repoRoot: otherRepo,
      branch: "fix/wrong-repo",
      isWorktree: false,
    });

    const back = await manager.setWorkspace("agt_a", { path: null });
    expect(back.workspacePath).toBeNull();
    expect(back.workspaceBaseBranch).toBeNull();
    expect(back.gitContext).toMatchObject({
      repoRoot: repo,
      branch: "agt/launch",
      worktreePath: launchWorktree,
    });
    expect(published).toEqual([otherRepo, "home"]);
  });

  it("keeps the launch base for a worktree the agent made in the same repo", async () => {
    await insertWorktreeAgent("agt_a", launchWorktree, "agt/launch");
    const moved = await manager.setWorkspace("agt_a", { path: ownWorktree });
    expect(moved.workspacePath).toBe(ownWorktree);
    expect(moved.workspaceBaseBranch).toBe("main");
    expect(moved.gitContext).toMatchObject({
      branch: "agt/own",
      isWorktree: true,
    });
  });

  it("rejects a path that does not exist without touching the row", async () => {
    await insertWorktreeAgent("agt_a", launchWorktree, "agt/launch");
    await expect(
      manager.setWorkspace("agt_a", { path: path.join(root, "missing") })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect((await manager.getAgent("agt_a"))?.workspacePath).toBeNull();
  });
});

describe("git context refresh", () => {
  it("drops a probe of a workspace the agent has since moved out of", async () => {
    await insertWorktreeAgent("agt_r", launchWorktree, "agt/launch");
    await manager.setWorkspace("agt_r", { path: otherRepo });
    const published: Array<string | undefined> = [];
    manager.onAgentUpdated((agent) => {
      if (agent.id === "agt_r") published.push(agent.gitContext?.repoRoot);
    });

    // The old repo changes, so its late probe would be a real write.
    git(otherRepo, "checkout", "-q", "-b", "fix/moved-on");
    let release!: () => void;
    probeGates.set(otherRepo, new Promise<void>((r) => (release = r)));
    // A settled turn starts probing the old workspace...
    const stale = manager.populateGitContext("agt_r", {
      publishIfChanged: true,
    });
    await vi.waitFor(() => expect(probeGates.has(otherRepo)).toBe(false));
    // ...the agent moves before it finishes...
    await manager.setWorkspace("agt_r", { path: ownWorktree });
    // ...and the old probe lands last.
    release();
    await stale;

    const agent = await manager.getAgent("agt_r");
    expect(agent?.workspacePath).toBe(ownWorktree);
    expect(agent?.gitContext).toMatchObject({
      worktreePath: ownWorktree,
      branch: "agt/own",
    });
    expect(published).toEqual([repo]);
    git(otherRepo, "checkout", "-q", "fix/wrong-repo");
  });

  it("reads a managed worktree's branch live and publishes only on change", async () => {
    const wt = path.join(root, "switch-wt");
    git(repo, "worktree", "add", "-q", "-b", "agt/switch", wt);
    await insertWorktreeAgent("agt_s", wt, "agt/switch");
    const published: string[] = [];
    manager.onAgentUpdated((agent) => {
      if (agent.id === "agt_s") published.push(agent.gitContext?.branch ?? "");
    });

    await manager.populateGitContext("agt_s", { publishIfChanged: true });
    expect(published).toEqual([]);

    git(wt, "checkout", "-q", "-b", "agt/renamed");
    await manager.populateGitContext("agt_s", { publishIfChanged: true });
    expect(published).toEqual(["agt/renamed"]);
    // The recorded branch archive cleanup keys on is left alone.
    expect((await manager.getAgent("agt_s"))?.worktreeBranch).toBe(
      "agt/switch"
    );
  });
});

describe("archive with a moved workspace", () => {
  it("never removes a worktree the agent only moved into", async () => {
    await insertWorktreeAgent("agt_a", launchWorktree, "agt/launch");
    await manager.setWorkspace("agt_a", { path: ownWorktree });

    await archive("agt_a");

    const cleaned = cleanupGitWorktreeSpy.mock.calls.map(
      (call) => (call as unknown as [{ cwd: string }])[0].cwd
    );
    expect(cleaned).toEqual([launchWorktree]);
  });

  it("spares a managed worktree another live agent has moved into", async () => {
    await insertWorktreeAgent("agt_owner", ownWorktree, "agt/own");
    await insertWorktreeAgent("agt_mover", launchWorktree, "agt/launch");
    await manager.setWorkspace("agt_mover", { path: ownWorktree });

    await archive("agt_owner");

    expect(cleanupGitWorktreeSpy).not.toHaveBeenCalled();
  });
});
