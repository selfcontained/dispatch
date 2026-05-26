import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginArchive,
  executeArchive,
  deleteAgentDirect,
} from "../src/agents/archive.js";
import type { ArchiveDeps } from "../src/agents/archive.js";
import { AgentError } from "../src/agents/errors.js";
import type { AgentRuntime } from "../src/agents/runtime.js";
import type {
  AgentRecord,
  ArchivePhase,
  WorktreeCleanupMode,
} from "../src/agents/types.js";

vi.mock("../src/agents/lifecycle-hooks.js", () => ({
  runLifecycleHook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/shared/git/worktree.js", () => ({
  cleanupGitWorktree: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/shared/git/worktree-status.js", () => ({
  getUnmergedChanges: vi.fn().mockResolvedValue({
    hasUnmergedCommits: false,
    changedFiles: [],
  }),
  getUncommittedChanges: vi.fn().mockResolvedValue({
    hasUncommittedChanges: false,
    uncommittedFiles: [],
  }),
}));

import { runLifecycleHook } from "../src/agents/lifecycle-hooks.js";
import { cleanupGitWorktree } from "../src/shared/git/worktree.js";
import {
  getUnmergedChanges,
  getUncommittedChanges,
} from "../src/shared/git/worktree-status.js";

// ── Helpers ─────────────────────────────────────────────────────────────

const noopLogger = (() => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: "silent",
    child: () => logger,
  };
  return logger as unknown as import("fastify").FastifyBaseLogger;
})();

const makeAgent = (
  id: string,
  overrides: Partial<AgentRecord> = {}
): AgentRecord => ({
  id,
  name: id,
  type: "claude",
  role: "standard",
  status: "stopped",
  cwd: "/tmp",
  worktreePath: null,
  worktreeBranch: null,
  tmuxSession: null,
  simulatorUdid: null,
  mediaDir: null,
  agentArgs: [],
  fullAccess: false,
  setupPhase: null,
  archivePhase: null,
  archiveCleanupMode: null,
  lastError: null,
  latestEvent: null,
  pins: [],
  gitContext: null,
  gitContextStale: false,
  gitContextUpdatedAt: null,
  persona: null,
  parentAgentId: null,
  personaContext: null,
  reviewAgentType: null,
  review: null,
  baseBranch: null,
  templateId: null,
  autoReview: false,
  cliSessionId: null,
  createdAt: "2026-05-01T00:00:00Z",
  updatedAt: "2026-05-01T00:00:00Z",
  ...overrides,
});

const makeRuntime = (overrides: Partial<AgentRuntime> = {}): AgentRuntime => ({
  tracksSessions: () => true,
  launch: vi.fn(),
  ensureNoExistingSession: vi.fn(),
  stopSession: vi.fn(),
  hasSession: vi.fn().mockResolvedValue(false),
  getCurrentCwd: vi.fn().mockResolvedValue(null),
  listSessions: vi.fn().mockResolvedValue([]),
  killSession: vi.fn().mockResolvedValue(undefined),
  readExitInfo: vi.fn().mockResolvedValue(null),
  readSetupLogTail: vi.fn().mockResolvedValue(""),
  ...overrides,
});

const makePool = (queryImpl?: (...args: unknown[]) => unknown) => ({
  query: vi.fn(queryImpl ?? (async () => ({ rows: [], rowCount: 0 }))),
});

const makeDeps = (overrides: Partial<ArchiveDeps> = {}): ArchiveDeps => {
  const pool = makePool();
  return {
    pool: pool as never,
    logger: noopLogger,
    runtime: makeRuntime(),
    diffStatsRefresher: { clear: vi.fn() },
    getAgent: vi.fn().mockResolvedValue(null),
    getRequiredAgent: vi.fn(),
    stopAgent: vi.fn().mockResolvedValue(makeAgent("a1")),
    harvestAgentTokens: vi.fn().mockResolvedValue(undefined),
    setAgentStatus: vi.fn().mockResolvedValue(undefined),
    setArchivePhase: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
};

const makeCallbacks = () => ({
  onPhaseChange: vi.fn(),
  onComplete: vi.fn(),
  onError: vi.fn(),
});

// ── beginArchive ────────────────────────────────────────────────────────

describe("beginArchive", () => {
  it("transitions agent to archiving status and returns the agent", async () => {
    const agent = makeAgent("a1");
    const pool = makePool(async () => ({ rows: [{ id: "a1" }], rowCount: 1 }));
    const deps = makeDeps({
      pool: pool as never,
      getRequiredAgent: vi.fn().mockResolvedValue(agent),
    });

    const result = await beginArchive(deps, "a1");

    expect(result).toBe(agent);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE agents"),
      ["a1", "auto"]
    );
  });

  it("passes the cleanup mode to the SQL update", async () => {
    const pool = makePool(async () => ({ rows: [{ id: "a1" }], rowCount: 1 }));
    const deps = makeDeps({
      pool: pool as never,
      getRequiredAgent: vi.fn().mockResolvedValue(makeAgent("a1")),
    });

    await beginArchive(deps, "a1", "force");

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE agents"),
      ["a1", "force"]
    );
  });

  it("throws 409 if the agent is already archiving", async () => {
    const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
    const deps = makeDeps({
      pool: pool as never,
      getAgent: vi
        .fn()
        .mockResolvedValue(makeAgent("a1", { status: "archiving" })),
    });

    await expect(beginArchive(deps, "a1")).rejects.toThrow(AgentError);
    await expect(beginArchive(deps, "a1")).rejects.toThrow(
      "Agent is already being archived."
    );
  });

  it("throws 404 if the agent does not exist", async () => {
    const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
    const deps = makeDeps({
      pool: pool as never,
      getAgent: vi.fn().mockResolvedValue(null),
    });

    await expect(beginArchive(deps, "a1")).rejects.toThrow(AgentError);
    try {
      await beginArchive(deps, "a1");
    } catch (err) {
      expect((err as AgentError).statusCode).toBe(404);
    }
  });

  it("defaults cleanupWorktree to auto", async () => {
    const pool = makePool(async () => ({ rows: [{ id: "a1" }], rowCount: 1 }));
    const deps = makeDeps({
      pool: pool as never,
      getRequiredAgent: vi.fn().mockResolvedValue(makeAgent("a1")),
    });

    await beginArchive(deps, "a1");

    expect(pool.query).toHaveBeenCalledWith(expect.any(String), ["a1", "auto"]);
  });
});

// ── executeArchive ──────────────────────────────────────────────────────

describe("executeArchive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUnmergedChanges).mockResolvedValue({
      hasUnmergedCommits: false,
      changedFiles: [],
    });
    vi.mocked(getUncommittedChanges).mockResolvedValue({
      hasUncommittedChanges: false,
      uncommittedFiles: [],
    });
  });

  describe("phase transitions", () => {
    it("progresses through all phases for an agent with a clean worktree", async () => {
      const agent = makeAgent("a1", {
        worktreePath: "/tmp/wt",
        worktreeBranch: "feat/test",
        archiveCleanupMode: "auto",
      });
      const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });
      const cb = makeCallbacks();

      await executeArchive(deps, "a1", cb);

      const phases = vi
        .mocked(deps.setArchivePhase)
        .mock.calls.map(([, phase]) => phase);
      expect(phases).toEqual([
        "worktree-check",
        "worktree-cleanup",
        "finalizing",
      ]);
      expect(cb.onComplete).toHaveBeenCalledWith(["a1"]);
      expect(cb.onError).not.toHaveBeenCalled();
    });

    it("skips worktree-cleanup phase when worktree is preserved", async () => {
      const agent = makeAgent("a1", {
        worktreePath: "/tmp/wt",
        archiveCleanupMode: "keep",
      });
      const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });
      const cb = makeCallbacks();

      await executeArchive(deps, "a1", cb);

      const phases = vi
        .mocked(deps.setArchivePhase)
        .mock.calls.map(([, phase]) => phase);
      expect(phases).toEqual(["worktree-check", "finalizing"]);
    });
  });

  describe("worktree cleanup decision — auto mode", () => {
    it("cleans up the worktree when there are no outstanding changes", async () => {
      const agent = makeAgent("a1", {
        worktreePath: "/tmp/wt",
        worktreeBranch: "feat/test",
        archiveCleanupMode: "auto",
      });
      const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(cleanupGitWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/tmp/wt" })
      );
    });

    it("preserves the worktree when there are unmerged commits", async () => {
      vi.mocked(getUnmergedChanges).mockResolvedValue({
        hasUnmergedCommits: true,
        changedFiles: ["file1.ts", "file2.ts"],
      });
      const agent = makeAgent("a1", {
        worktreePath: "/tmp/wt",
        archiveCleanupMode: "auto",
      });
      const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(cleanupGitWorktree).not.toHaveBeenCalled();
    });

    it("preserves the worktree when there are uncommitted changes", async () => {
      vi.mocked(getUncommittedChanges).mockResolvedValue({
        hasUncommittedChanges: true,
        uncommittedFiles: ["dirty.ts"],
      });
      const agent = makeAgent("a1", {
        worktreePath: "/tmp/wt",
        archiveCleanupMode: "auto",
      });
      const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(cleanupGitWorktree).not.toHaveBeenCalled();
    });

    it("preserves worktree when both unmerged and uncommitted changes exist", async () => {
      vi.mocked(getUnmergedChanges).mockResolvedValue({
        hasUnmergedCommits: true,
        changedFiles: ["a.ts"],
      });
      vi.mocked(getUncommittedChanges).mockResolvedValue({
        hasUncommittedChanges: true,
        uncommittedFiles: ["b.ts"],
      });
      const agent = makeAgent("a1", {
        worktreePath: "/tmp/wt",
        archiveCleanupMode: "auto",
      });
      const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(cleanupGitWorktree).not.toHaveBeenCalled();
    });
  });

  describe("worktree cleanup decision — force mode", () => {
    it("always cleans up when mode is force, even with outstanding changes", async () => {
      vi.mocked(getUnmergedChanges).mockResolvedValue({
        hasUnmergedCommits: true,
        changedFiles: ["file.ts"],
      });
      const agent = makeAgent("a1", {
        worktreePath: "/tmp/wt",
        worktreeBranch: "feat/test",
        archiveCleanupMode: "force",
      });
      const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(cleanupGitWorktree).toHaveBeenCalled();
      expect(getUnmergedChanges).not.toHaveBeenCalled();
    });
  });

  describe("worktree cleanup decision — keep mode", () => {
    it("never cleans up the worktree when mode is keep", async () => {
      const agent = makeAgent("a1", {
        worktreePath: "/tmp/wt",
        archiveCleanupMode: "keep",
      });
      const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(cleanupGitWorktree).not.toHaveBeenCalled();
      expect(getUnmergedChanges).not.toHaveBeenCalled();
      expect(getUncommittedChanges).not.toHaveBeenCalled();
    });
  });

  describe("branch deletion decision", () => {
    it("deletes branch when dispatch owns it (worktreeBranch != baseBranch)", async () => {
      const agent = makeAgent("a1", {
        worktreePath: "/tmp/wt",
        worktreeBranch: "dispatch/a1",
        baseBranch: "main",
        archiveCleanupMode: "auto",
      });
      const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(cleanupGitWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ deleteBranch: true })
      );
    });

    it("does not delete branch when worktreeBranch equals baseBranch", async () => {
      const agent = makeAgent("a1", {
        worktreePath: "/tmp/wt",
        worktreeBranch: "main",
        baseBranch: "main",
        archiveCleanupMode: "auto",
      });
      const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(cleanupGitWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ deleteBranch: false })
      );
    });

    it("does not delete branch when worktreeBranch is null", async () => {
      const agent = makeAgent("a1", {
        worktreePath: "/tmp/wt",
        worktreeBranch: null,
        archiveCleanupMode: "auto",
      });
      const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(cleanupGitWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ deleteBranch: false })
      );
    });

    it("deletes branch when baseBranch is null but worktreeBranch exists", async () => {
      const agent = makeAgent("a1", {
        worktreePath: "/tmp/wt",
        worktreeBranch: "dispatch/a1",
        baseBranch: null,
        archiveCleanupMode: "auto",
      });
      const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(cleanupGitWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ deleteBranch: true })
      );
    });
  });

  describe("no worktree path", () => {
    it("skips worktree cleanup when agent has no worktreePath", async () => {
      const agent = makeAgent("a1", { worktreePath: null });
      const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(cleanupGitWorktree).not.toHaveBeenCalled();
      expect(getUnmergedChanges).not.toHaveBeenCalled();
    });
  });

  describe("tmux session teardown", () => {
    it("stops the tmux session if it exists", async () => {
      const runtime = makeRuntime({
        hasSession: vi.fn().mockResolvedValue(true),
        stopSession: vi.fn().mockResolvedValue(undefined),
      });
      const agent = makeAgent("a1", { tmuxSession: "session-a1" });
      const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
      const deps = makeDeps({
        pool: pool as never,
        runtime,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(runtime.hasSession).toHaveBeenCalledWith("session-a1");
      expect(runtime.stopSession).toHaveBeenCalledWith("session-a1", true);
    });

    it("skips session stop when tmuxSession is null", async () => {
      const runtime = makeRuntime();
      const agent = makeAgent("a1", { tmuxSession: null });
      const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
      const deps = makeDeps({
        pool: pool as never,
        runtime,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(runtime.hasSession).not.toHaveBeenCalled();
      expect(runtime.stopSession).not.toHaveBeenCalled();
    });

    it("skips session stop when runtime says session does not exist", async () => {
      const runtime = makeRuntime({
        hasSession: vi.fn().mockResolvedValue(false),
        stopSession: vi.fn(),
      });
      const agent = makeAgent("a1", { tmuxSession: "session-a1" });
      const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
      const deps = makeDeps({
        pool: pool as never,
        runtime,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(runtime.hasSession).toHaveBeenCalledWith("session-a1");
      expect(runtime.stopSession).not.toHaveBeenCalled();
    });
  });

  describe("lifecycle hook", () => {
    it("runs the stop lifecycle hook", async () => {
      const agent = makeAgent("a1");
      const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(runLifecycleHook).toHaveBeenCalledWith(
        "stop",
        agent,
        expect.anything()
      );
    });

    it("continues archive even if lifecycle hook fails", async () => {
      vi.mocked(runLifecycleHook).mockRejectedValueOnce(
        new Error("hook failed")
      );
      const agent = makeAgent("a1");
      const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });
      const cb = makeCallbacks();

      await executeArchive(deps, "a1", cb);

      expect(cb.onComplete).toHaveBeenCalled();
      expect(cb.onError).not.toHaveBeenCalled();
    });
  });

  describe("cascade child deletion", () => {
    it("deletes child agents found in the database", async () => {
      const parent = makeAgent("parent");
      const child = makeAgent("child", {
        parentAgentId: "parent",
        status: "stopped",
      });

      let queryCallCount = 0;
      const queryImpl = async (sql: string) => {
        queryCallCount++;
        if (sql.includes("INSERT INTO agent_events")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("SELECT id FROM agents WHERE parent_agent_id")) {
          if (sql.includes("parent_agent_id = $1") && queryCallCount <= 4) {
            return { rows: [{ id: "child" }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("UPDATE agents SET deleted_at")) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      };
      const pool = makePool(queryImpl);
      const getRequiredAgent = vi
        .fn()
        .mockImplementation(async (id: string) => {
          return id === "parent" ? parent : child;
        });
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent,
        getAgent: vi.fn().mockImplementation(async (id: string) => {
          return id === "parent" ? parent : child;
        }),
      });
      const cb = makeCallbacks();

      await executeArchive(deps, "parent", cb);

      expect(cb.onComplete).toHaveBeenCalledWith(["parent", "child"]);
    });

    it("continues if a child cascade fails", async () => {
      const parent = makeAgent("parent");

      let queryCallCount = 0;
      const queryImpl = async (sql: string) => {
        queryCallCount++;
        if (sql.includes("SELECT id FROM agents WHERE parent_agent_id")) {
          if (queryCallCount <= 4) {
            return { rows: [{ id: "bad-child" }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("INSERT INTO agent_events")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("UPDATE agents SET deleted_at")) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      };
      const pool = makePool(queryImpl);
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockImplementation(async (id: string) => {
          if (id === "bad-child") throw new Error("child not found");
          return parent;
        }),
        getAgent: vi.fn().mockResolvedValue(parent),
      });
      const cb = makeCallbacks();

      await executeArchive(deps, "parent", cb);

      expect(cb.onComplete).toHaveBeenCalled();
      expect(noopLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ childId: "bad-child" }),
        expect.any(String)
      );
    });
  });

  describe("error handling", () => {
    it("calls onError and sets agent status to error when archive fails", async () => {
      const deps = makeDeps({
        getRequiredAgent: vi
          .fn()
          .mockRejectedValue(new Error("db connection lost")),
      });
      const cb = makeCallbacks();

      await executeArchive(deps, "a1", cb);

      expect(cb.onError).toHaveBeenCalledWith(expect.any(Error));
      expect(cb.onComplete).not.toHaveBeenCalled();
      expect(deps.setAgentStatus).toHaveBeenCalledWith(
        "a1",
        "error",
        "db connection lost"
      );
      expect(deps.setArchivePhase).toHaveBeenCalledWith("a1", null);
    });

    it("handles worktree cleanup errors gracefully (continues to finalize)", async () => {
      vi.mocked(cleanupGitWorktree).mockRejectedValueOnce(
        new Error("worktree locked")
      );
      const agent = makeAgent("a1", {
        worktreePath: "/tmp/wt",
        worktreeBranch: "feat",
        archiveCleanupMode: "force",
      });
      const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });
      const cb = makeCallbacks();

      await executeArchive(deps, "a1", cb);

      expect(cb.onComplete).toHaveBeenCalled();
      expect(noopLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "a1" }),
        "Worktree cleanup failed; leaving on disk."
      );
    });
  });

  describe("diffStatsRefresher", () => {
    it("clears diff stats for the archived agent", async () => {
      const agent = makeAgent("a1");
      const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
      const diffStatsRefresher = { clear: vi.fn() };
      const deps = makeDeps({
        pool: pool as never,
        diffStatsRefresher,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(diffStatsRefresher.clear).toHaveBeenCalledWith("a1");
    });

    it("tolerates null diffStatsRefresher", async () => {
      const agent = makeAgent("a1");
      const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
      const deps = makeDeps({
        pool: pool as never,
        diffStatsRefresher: null,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await expect(
        executeArchive(deps, "a1", makeCallbacks())
      ).resolves.toBeUndefined();
    });
  });
});

// ── deleteAgentDirect ───────────────────────────────────────────────────

describe("deleteAgentDirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes a stopped agent without calling stopAgent", async () => {
    const agent = makeAgent("a1", { status: "stopped" });
    const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
    const deps = makeDeps({
      pool: pool as never,
      getRequiredAgent: vi.fn().mockResolvedValue(agent),
    });

    await deleteAgentDirect(deps, "a1");

    expect(deps.stopAgent).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE agents SET deleted_at"),
      ["a1"]
    );
  });

  it("stops a non-stopped agent before deleting", async () => {
    const agent = makeAgent("a1", { status: "running", tmuxSession: "s1" });
    const runtime = makeRuntime({
      hasSession: vi.fn().mockResolvedValue(true),
    });
    const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
    const deps = makeDeps({
      pool: pool as never,
      runtime,
      getRequiredAgent: vi.fn().mockResolvedValue(agent),
      stopAgent: vi.fn().mockResolvedValue(agent),
    });

    await deleteAgentDirect(deps, "a1", true);

    expect(deps.stopAgent).toHaveBeenCalledWith("a1", { force: true });
  });

  it("throws 409 for a running agent with active session without force", async () => {
    const agent = makeAgent("a1", { status: "running", tmuxSession: "s1" });
    const runtime = makeRuntime({
      hasSession: vi.fn().mockResolvedValue(true),
    });
    const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
    const deps = makeDeps({
      pool: pool as never,
      runtime,
      getRequiredAgent: vi.fn().mockResolvedValue(agent),
    });

    await expect(deleteAgentDirect(deps, "a1", false)).rejects.toThrow(
      "Agent is running. Stop it first or use force delete."
    );
  });

  it("allows deleting a running agent without session (no force needed)", async () => {
    const agent = makeAgent("a1", { status: "running", tmuxSession: null });
    const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
    const deps = makeDeps({
      pool: pool as never,
      getRequiredAgent: vi.fn().mockResolvedValue(agent),
      stopAgent: vi.fn().mockResolvedValue(agent),
    });

    await deleteAgentDirect(deps, "a1", false);

    expect(deps.stopAgent).toHaveBeenCalledWith("a1", { force: true });
  });

  it("allows deleting a running agent whose session no longer exists", async () => {
    const agent = makeAgent("a1", { status: "running", tmuxSession: "s1" });
    const runtime = makeRuntime({
      hasSession: vi.fn().mockResolvedValue(false),
    });
    const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
    const deps = makeDeps({
      pool: pool as never,
      runtime,
      getRequiredAgent: vi.fn().mockResolvedValue(agent),
      stopAgent: vi.fn().mockResolvedValue(agent),
    });

    await deleteAgentDirect(deps, "a1", false);

    expect(deps.stopAgent).toHaveBeenCalled();
  });

  it("continues deletion even if stopAgent fails", async () => {
    const agent = makeAgent("a1", { status: "running", tmuxSession: null });
    const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
    const deps = makeDeps({
      pool: pool as never,
      getRequiredAgent: vi.fn().mockResolvedValue(agent),
      stopAgent: vi.fn().mockRejectedValue(new Error("stop failed")),
    });

    await deleteAgentDirect(deps, "a1", true);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE agents SET deleted_at"),
      ["a1"]
    );
  });

  it("cascades to child agents recursively", async () => {
    const parent = makeAgent("p1", { status: "stopped" });
    const child = makeAgent("c1", { status: "stopped", parentAgentId: "p1" });

    let childQueryCount = 0;
    const queryImpl = async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT id FROM agents WHERE parent_agent_id")) {
        const targetId = (params as string[])?.[0];
        if (targetId === "p1" && childQueryCount === 0) {
          childQueryCount++;
          return { rows: [{ id: "c1" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    };
    const pool = makePool(queryImpl);
    const deps = makeDeps({
      pool: pool as never,
      getRequiredAgent: vi.fn().mockImplementation(async (id: string) => {
        return id === "p1" ? parent : child;
      }),
    });

    await deleteAgentDirect(deps, "p1");

    const deleteCalls = pool.query.mock.calls.filter(
      ([sql]: [string]) =>
        typeof sql === "string" && sql.includes("UPDATE agents SET deleted_at")
    );
    expect(deleteCalls).toHaveLength(2);
  });

  it("clears diffStatsRefresher", async () => {
    const agent = makeAgent("a1", { status: "stopped" });
    const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
    const diffStatsRefresher = { clear: vi.fn() };
    const deps = makeDeps({
      pool: pool as never,
      diffStatsRefresher,
      getRequiredAgent: vi.fn().mockResolvedValue(agent),
    });

    await deleteAgentDirect(deps, "a1");

    expect(diffStatsRefresher.clear).toHaveBeenCalledWith("a1");
  });

  it("passes cleanupWorktree mode through to child cascade", async () => {
    const parent = makeAgent("p1", { status: "stopped" });
    const child = makeAgent("c1", {
      status: "stopped",
      parentAgentId: "p1",
    });

    let childQueryDone = false;
    const queryImpl = async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT id FROM agents WHERE parent_agent_id")) {
        const targetId = (params as string[])?.[0];
        if (targetId === "p1" && !childQueryDone) {
          childQueryDone = true;
          return { rows: [{ id: "c1" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    };
    const pool = makePool(queryImpl);
    const deps = makeDeps({
      pool: pool as never,
      getRequiredAgent: vi.fn().mockImplementation(async (id: string) => {
        return id === "p1" ? parent : child;
      }),
    });

    await deleteAgentDirect(deps, "p1", false, "force");

    expect(deps.getRequiredAgent).toHaveBeenCalledWith("c1");
    const childDeleteCalls = pool.query.mock.calls.filter(
      ([sql, params]: [string, unknown[]?]) =>
        typeof sql === "string" &&
        sql.includes("UPDATE agents SET deleted_at") &&
        params?.[0] === "c1"
    );
    expect(childDeleteCalls).toHaveLength(1);
  });
});
