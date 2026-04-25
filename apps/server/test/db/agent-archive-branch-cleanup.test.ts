/**
 * Verifies that archiving an agent's worktree only deletes the branch that
 * Dispatch created — never the user's pre-existing starting branch. This is
 * the safety net for the CRU-139 "managed worktree on an existing branch"
 * flow: if the agent was created with createNewBranch=false, the worktree is
 * on the user's own branch (e.g. main, feature/x), and archive cleanup must
 * not `git branch -D` it.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import type { Pool } from "pg";

import { setupTestDb, teardownTestDb, runTestMigrations } from "./setup.js";

// Silence tmux side effects from AgentManager.
vi.mock("../../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

// Stub the worktree helpers so we can (a) skip real git work during archive
// and (b) observe what AgentManager asks us to do.
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
  return {
    ...actual,
    cleanupGitWorktree: cleanupGitWorktreeSpy,
    createGitWorktree: vi.fn(async (input) => ({
      repoRoot: "/tmp/repo",
      worktreePath: "/tmp/repo-wt",
      worktreeName: "repo-wt",
      branchName:
        input.createNewBranch === false
          ? (input.baseBranch ?? "main")
          : (input.branchName ?? "work"),
      baseBranch: input.baseBranch ?? "main",
      baseRef: `origin/${input.baseBranch ?? "main"}`,
      baseSha: "deadbeef",
    })),
  };
});

const { AgentManager, AgentError } =
  await import("../../src/agents/manager.js");

let pool: Pool;

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
  mediaRoot: "/tmp/dispatch-test-media",
  dispatchBinDir: "/tmp",
  codexBin: "echo",
  claudeBin: "echo",
  opencodeBin: "echo",
  agentRuntime: "inert",
  sessionPrefix: "dispatch",
  tls: null,
} satisfies import("../../src/config.js").AppConfig;

let manager: InstanceType<typeof AgentManager>;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  manager = new AgentManager(pool, noopLogger, inertConfig);
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await pool.query("DELETE FROM agent_feedback");
  await pool.query("DELETE FROM media_seen");
  await pool.query("DELETE FROM media");
  await pool.query("DELETE FROM agents");
  cleanupGitWorktreeSpy.mockClear();
});

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

describe("archive branch cleanup", () => {
  it("preserves the user's branch when the worktree was started on it (createNewBranch=false)", async () => {
    const agent = await manager.createAgent({
      cwd: "/tmp",
      useWorktree: true,
      createNewBranch: false,
      baseBranch: "feature/x",
    });

    // AgentManager records worktree_branch === base_branch for this flow.
    expect(agent.worktreeBranch).toBe("feature/x");
    expect(agent.baseBranch).toBe("feature/x");

    await archive(agent.id);

    expect(cleanupGitWorktreeSpy).toHaveBeenCalledTimes(1);
    expect(cleanupGitWorktreeSpy.mock.calls[0][0]).toMatchObject({
      deleteBranch: false,
      force: true,
    });
  });

  it("deletes the dispatch-created branch when archiving an agent that forked a new branch", async () => {
    const agent = await manager.createAgent({
      cwd: "/tmp",
      useWorktree: true,
      createNewBranch: true,
      baseBranch: "main",
      worktreeBranch: "feat/auto-generated",
    });

    expect(agent.worktreeBranch).toBe("feat/auto-generated");
    expect(agent.baseBranch).toBe("main");

    await archive(agent.id);

    expect(cleanupGitWorktreeSpy).toHaveBeenCalledTimes(1);
    expect(cleanupGitWorktreeSpy.mock.calls[0][0]).toMatchObject({
      deleteBranch: true,
      force: true,
    });
  });

  it("normalizes whitespace-padded baseBranch so the ownership check is consistent (review #1159)", async () => {
    // Regression: persisting `input.baseBranch` raw while the worktree branch
    // gets trimmed makes the archive heuristic falsely classify the user's
    // branch as Dispatch-owned. Normalizing both sides up front fixes it.
    const agent = await manager.createAgent({
      cwd: "/tmp",
      useWorktree: true,
      createNewBranch: false,
      baseBranch: "  feature/x  ",
    });

    expect(agent.baseBranch).toBe("feature/x");
    expect(agent.worktreeBranch).toBe("feature/x");

    await archive(agent.id);

    expect(cleanupGitWorktreeSpy).toHaveBeenCalledTimes(1);
    expect(cleanupGitWorktreeSpy.mock.calls[0][0]).toMatchObject({
      deleteBranch: false,
      force: true,
    });
  });

  it("rejects baseBranch values containing shell metacharacters (review #1158)", async () => {
    await expect(
      manager.createAgent({
        cwd: "/tmp",
        useWorktree: true,
        createNewBranch: false,
        baseBranch: 'main"; touch /tmp/pwned; #',
      })
    ).rejects.toBeInstanceOf(AgentError);
  });

  it("rejects worktreeBranch values containing shell metacharacters (review #1158)", async () => {
    await expect(
      manager.createAgent({
        cwd: "/tmp",
        useWorktree: true,
        createNewBranch: true,
        worktreeBranch: "feat$(rm -rf /)",
      })
    ).rejects.toBeInstanceOf(AgentError);
  });

  it("deletes the branch for legacy agents where baseBranch is unset (no confident way to tell otherwise)", async () => {
    // Older records created before CRU-139 don't have base_branch populated.
    // The cleanup heuristic should still delete the branch in that case so the
    // pre-existing behavior is preserved for old rows.
    const agent = await manager.createAgent({
      cwd: "/tmp",
      useWorktree: true,
      createNewBranch: true,
      worktreeBranch: "legacy/branch",
    });

    // Force base_branch to NULL to simulate a pre-migration row.
    await pool.query("UPDATE agents SET base_branch = NULL WHERE id = $1", [
      agent.id,
    ]);

    await archive(agent.id);

    expect(cleanupGitWorktreeSpy).toHaveBeenCalledTimes(1);
    expect(cleanupGitWorktreeSpy.mock.calls[0][0]).toMatchObject({
      deleteBranch: true,
      force: true,
    });
  });
});
