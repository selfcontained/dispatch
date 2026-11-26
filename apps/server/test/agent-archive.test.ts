import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginArchive,
  executeArchive,
  deleteAgentDirect,
} from "../src/agents/archive.js";
import type { ArchiveDeps } from "../src/agents/archive.js";
import { AgentError } from "../src/agents/errors.js";
import {
  createInertRuntime,
  type AgentRuntime,
} from "../src/agents/runtime.js";
import type {
  AgentRecord,
  ArchivePhase,
  WorktreeCleanupMode,
} from "../src/agents/types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    lstat: (path: string, ...options: []) =>
      path.startsWith("/tmp/wt")
        ? Promise.resolve({})
        : fs.lstat(path, ...options),
  };
});

vi.mock("../src/agents/lifecycle-hooks.js", () => ({
  runLifecycleHook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../packages/runner/src/workload/shared/git/worktree.js", () => ({
  cleanupGitWorktree: vi.fn().mockResolvedValue(undefined),
}));

vi.mock(
  "../../../packages/runner/src/workload/agents/checkout-inspection.js",
  () => ({
    observeGitCheckout: vi.fn(),
  })
);

// The local runner's removal port, over the mocked Git cleanup above: these
// tests are about the archive's sequence. archive-policy.test.ts removes
// real worktrees through the real port.
vi.mock(
  "../../../packages/runner/src/workload/agents/checkout-worker.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../packages/runner/src/workload/agents/checkout-worker.js")
      >();
    const { lstat } = await import("node:fs/promises");
    const { cleanupGitWorktree } =
      await import("../../../packages/runner/src/workload/shared/git/worktree.js");
    return {
      ...actual,
      workspaceWorkload: {
        ...actual.workspaceWorkload,
        async release(
          _session: string,
          checkout: { path: string },
          request: { deleteBranch: boolean; originalBranch: string | null }
        ) {
          if (!(await lstat(checkout.path).catch(() => null))) return true;
          await cleanupGitWorktree(
            { cwd: checkout.path, force: true, ...request },
            async () => ({ exitCode: 0, stdout: "", stderr: "" })
          );
          return true;
        },
      },
    };
  }
);

import { runLifecycleHook } from "../src/agents/lifecycle-hooks.js";
import { cleanupGitWorktree } from "../../../packages/runner/src/workload/shared/git/worktree.js";
import { observeGitCheckout } from "../../../packages/runner/src/workload/agents/checkout-inspection.js";
import {
  controllerPlacement,
  placementForRunner,
} from "../src/runners/placement.js";

const cleanCheckout = {
  path: "/tmp/wt",
  branch: "feature",
  stateId: "a".repeat(64),
  unmerged: false,
  changedFiles: [],
  uncommittedFiles: [],
};

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
  placement: controllerPlacement,
  cwd: "/tmp",
  worktreePath: null,
  worktreeBranch: null,
  simulatorUdid: null,
  filesDir: null,
  agentArgs: [],
  fullAccess: false,
  setupPhase: null,
  archivePhase: null,
  archiveCleanupMode: null,
  lastError: null,

  gitContext: null,
  gitContextStale: false,
  gitContextUpdatedAt: null,
  persona: null,
  parentAgentId: null,
  launchedByAgentId: null,
  personaContext: null,
  reviewAgentType: null,
  baseBranch: null,
  templateId: null,
  cliSessionId: null,
  createdAt: "2026-05-01T00:00:00Z",
  updatedAt: "2026-05-01T00:00:00Z",
  ...overrides,
});

const makeRuntime = (overrides: Partial<AgentRuntime> = {}): AgentRuntime => ({
  ...createInertRuntime(),
  stop: vi.fn().mockResolvedValue(undefined),
  discard: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

/** The CAS `deleteAgentDirect` takes before any teardown. */
const isArchiveClaim = (sql: unknown) =>
  typeof sql === "string" &&
  sql.includes("SET status = 'archiving'") &&
  sql.includes("RETURNING id");

/** Answers the claim as Postgres would for an unclaimed agent. */
const defaultQueryImpl = async (sql: unknown) =>
  isArchiveClaim(sql)
    ? { rows: [{ id: "claimed" }], rowCount: 1 }
    : { rows: [], rowCount: 0 };

const makePool = (queryImpl?: (...args: unknown[]) => unknown) => ({
  query: vi.fn(queryImpl ?? defaultQueryImpl),
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
    setAgentStatus: vi.fn().mockResolvedValue(undefined),
    beginStopStream: vi.fn(),
    settleStream: vi.fn().mockResolvedValue(0),
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
      ["a1", "auto", null]
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
      ["a1", "force", null]
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

    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [
      "a1",
      "auto",
      null,
    ]);
  });
});

// ── executeArchive ──────────────────────────────────────────────────────

describe("executeArchive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(observeGitCheckout).mockResolvedValue(cleanCheckout);
  });

  describe("phase transitions", () => {
    it("progresses through all phases for an agent with a clean worktree", async () => {
      const agent = makeAgent("a1", {
        worktreePath: "/tmp/wt",
        worktreeBranch: "feat/test",
        archiveCleanupMode: "auto",
      });
      const pool = makePool();
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
      const pool = makePool();
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
      const pool = makePool();
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(cleanupGitWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/tmp/wt" }),
        expect.any(Function)
      );
    });

    it("preserves the worktree when there are unmerged commits", async () => {
      vi.mocked(observeGitCheckout).mockResolvedValue({
        ...cleanCheckout,
        unmerged: true,
        changedFiles: ["file1.ts", "file2.ts"],
      });
      const agent = makeAgent("a1", {
        worktreePath: "/tmp/wt",
        archiveCleanupMode: "auto",
      });
      const pool = makePool();
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(cleanupGitWorktree).not.toHaveBeenCalled();
    });

    it("preserves the worktree when there are uncommitted changes", async () => {
      vi.mocked(observeGitCheckout).mockResolvedValue({
        ...cleanCheckout,
        uncommittedFiles: ["dirty.ts"],
      });
      const agent = makeAgent("a1", {
        worktreePath: "/tmp/wt",
        archiveCleanupMode: "auto",
      });
      const pool = makePool();
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(cleanupGitWorktree).not.toHaveBeenCalled();
    });

    it("preserves worktree when both unmerged and uncommitted changes exist", async () => {
      vi.mocked(observeGitCheckout).mockResolvedValue({
        ...cleanCheckout,
        unmerged: true,
        changedFiles: ["a.ts"],
        uncommittedFiles: ["b.ts"],
      });
      const agent = makeAgent("a1", {
        worktreePath: "/tmp/wt",
        archiveCleanupMode: "auto",
      });
      const pool = makePool();
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
    it("authorizes the observed checkout in force mode even with outstanding changes", async () => {
      vi.mocked(observeGitCheckout).mockResolvedValue({
        ...cleanCheckout,
        unmerged: true,
        changedFiles: ["file.ts"],
      });
      const agent = makeAgent("a1", {
        worktreePath: "/tmp/wt",
        worktreeBranch: "feat/test",
        archiveCleanupMode: "force",
      });
      const pool = makePool();
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(cleanupGitWorktree).toHaveBeenCalled();
      expect(observeGitCheckout).not.toHaveBeenCalled();
    });
  });

  it("attempts auto cleanup when the built-in runner cannot observe the checkout", async () => {
    vi.mocked(observeGitCheckout).mockRejectedValueOnce(
      new Error("Git status unavailable")
    );
    const deps = makeDeps({
      getRequiredAgent: vi.fn().mockResolvedValue(
        makeAgent("a1", {
          worktreePath: "/tmp/wt",
          archiveCleanupMode: "auto",
        })
      ),
    });
    await executeArchive(deps, "a1", makeCallbacks());
    expect(cleanupGitWorktree).toHaveBeenCalledOnce();
  });

  describe("worktree cleanup decision — keep mode", () => {
    it("never cleans up the worktree when mode is keep", async () => {
      const agent = makeAgent("a1", {
        worktreePath: "/tmp/wt",
        archiveCleanupMode: "keep",
      });
      const pool = makePool();
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(cleanupGitWorktree).not.toHaveBeenCalled();
      expect(observeGitCheckout).not.toHaveBeenCalled();
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
      const pool = makePool();
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(cleanupGitWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ deleteBranch: true }),
        expect.any(Function)
      );
    });

    it("does not delete branch when worktreeBranch equals baseBranch", async () => {
      const agent = makeAgent("a1", {
        worktreePath: "/tmp/wt",
        worktreeBranch: "main",
        baseBranch: "main",
        archiveCleanupMode: "auto",
      });
      const pool = makePool();
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(cleanupGitWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ deleteBranch: false }),
        expect.any(Function)
      );
    });

    it("does not delete branch when worktreeBranch is null", async () => {
      const agent = makeAgent("a1", {
        worktreePath: "/tmp/wt",
        worktreeBranch: null,
        archiveCleanupMode: "auto",
      });
      const pool = makePool();
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(cleanupGitWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ deleteBranch: false }),
        expect.any(Function)
      );
    });

    it("deletes branch when baseBranch is null but worktreeBranch exists", async () => {
      const agent = makeAgent("a1", {
        worktreePath: "/tmp/wt",
        worktreeBranch: "dispatch/a1",
        baseBranch: null,
        archiveCleanupMode: "auto",
      });
      const pool = makePool();
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(cleanupGitWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ deleteBranch: true }),
        expect.any(Function)
      );
    });
  });

  describe("no worktree path", () => {
    it("skips worktree cleanup when agent has no worktreePath", async () => {
      const agent = makeAgent("a1", { worktreePath: null });
      const pool = makePool();
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(cleanupGitWorktree).not.toHaveBeenCalled();
      expect(observeGitCheckout).not.toHaveBeenCalled();
    });
  });

  describe("host teardown", () => {
    it("force-stops the host, settles the stream and discards its state", async () => {
      const runtime = makeRuntime();
      const agent = makeAgent("a1", { status: "running" });
      const pool = makePool();
      const settleStream = vi.fn().mockResolvedValue(1);
      const deps = makeDeps({
        pool: pool as never,
        runtime,
        settleStream,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(runtime.stop).toHaveBeenCalledWith("a1", true);
      expect(settleStream).toHaveBeenCalledWith("a1");
      expect(runtime.discard).toHaveBeenCalledWith("a1");
    });

    it("continues the archive when stopping the host fails", async () => {
      const runtime = makeRuntime({
        stop: vi.fn().mockRejectedValue(new Error("socket gone")),
      });
      const agent = makeAgent("a1");
      const pool = makePool();
      const callbacks = makeCallbacks();
      const deps = makeDeps({
        pool: pool as never,
        runtime,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", callbacks);

      expect(callbacks.onError).not.toHaveBeenCalled();
      expect(callbacks.onComplete).toHaveBeenCalled();
    });
  });

  describe("lifecycle hook", () => {
    it("runs the stop lifecycle hook", async () => {
      const agent = makeAgent("a1");
      const pool = makePool();
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });

      await executeArchive(deps, "a1", makeCallbacks());

      expect(runLifecycleHook).toHaveBeenCalledWith(
        "stop",
        agent,
        expect.anything(),
        { remote: undefined },
        undefined
      );
    });

    it("continues archive if the stop hook fails", async () => {
      vi.mocked(runLifecycleHook).mockRejectedValueOnce(
        new Error("hook failed")
      );
      const agent = makeAgent("a1");
      const pool = makePool();
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
    it.each(["running", "stopped"] as const)(
      "wipes the dev stack of a %s agent even when its worktree is kept",
      async (status) => {
        const agent = makeAgent("a1", {
          status,
          worktreePath: "/worktree",
          archiveCleanupMode: "keep",
        });
        const pool = makePool();
        const deps = makeDeps({
          pool: pool as never,
          getRequiredAgent: vi.fn().mockResolvedValue(agent),
          getAgent: vi.fn().mockResolvedValue(agent),
        });
        const callbacks = makeCallbacks();

        await executeArchive(deps, "a1", callbacks);

        expect(runLifecycleHook).toHaveBeenCalledWith(
          "archive",
          agent,
          expect.anything(),
          expect.anything(),
          undefined
        );
        expect(cleanupGitWorktree).not.toHaveBeenCalled();
        expect(callbacks.onComplete).toHaveBeenCalledWith(["a1"]);
      }
    );

    it("surfaces a cleanup failure and leaves the agent available for a retry", async () => {
      const failure = new Error("database volume is in use");
      vi.mocked(runLifecycleHook)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(failure);
      const agent = makeAgent("a1");
      const pool = makePool();
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(agent),
        getAgent: vi.fn().mockResolvedValue(agent),
      });
      const callbacks = makeCallbacks();

      await executeArchive(deps, "a1", callbacks);

      expect(deps.setAgentStatus).toHaveBeenCalledWith(
        "a1",
        "error",
        failure.message
      );
      expect(deps.setArchivePhase).toHaveBeenCalledWith("a1", null);
      expect(callbacks.onError).toHaveBeenCalledWith(failure);
      expect(callbacks.onComplete).not.toHaveBeenCalled();
      expect(pool.query).not.toHaveBeenCalledWith(
        expect.stringContaining("SET deleted_at"),
        expect.anything()
      );

      await executeArchive(deps, "a1", callbacks);
      expect(callbacks.onComplete).toHaveBeenCalledWith(["a1"]);
    });
  });

  describe("cascade child deletion", () => {
    /**
     * Answers from whichever column the SQL names, so widening the query to
     * `OR launched_by_agent_id = $1` fails the assertions below.
     */
    const makeChildQueryPool = (
      rows: {
        id: string;
        parentAgentId?: string | null;
        launchedByAgentId?: string | null;
        role?: string;
      }[]
    ) =>
      makePool(async (sql: string, params?: unknown[]) => {
        if (sql.includes("FROM agents") && sql.includes("parent_agent_id")) {
          const targetId = params?.[0];
          const matched = rows
            .filter(
              (row) =>
                row.parentAgentId === targetId ||
                (sql.includes("launched_by_agent_id") &&
                  row.role === "review" &&
                  row.launchedByAgentId === targetId)
            )
            .map((row) => ({ id: row.id }));
          return { rows: matched, rowCount: matched.length };
        }
        return defaultQueryImpl(sql);
      });

    const makeAgentLookup = (agents: AgentRecord[]) =>
      vi.fn().mockImplementation(async (id: string) => {
        const found = agents.find((agent) => agent.id === id);
        if (!found) throw new Error(`agent not found: ${id}`);
        return found;
      });

    const deletedAgentIds = (pool: ReturnType<typeof makePool>) =>
      pool.query.mock.calls
        .filter(
          ([sql]: [string]) =>
            typeof sql === "string" && sql.includes("SET deleted_at = NOW()")
        )
        .map(([, params]: [string, unknown[]?]) => params?.[0]);

    it("deletes review child agents", async () => {
      const parent = makeAgent("parent");
      const child = makeAgent("child", {
        parentAgentId: "parent",
        role: "review",
        status: "stopped",
      });

      const pool = makeChildQueryPool([
        { id: "child", parentAgentId: "parent" },
      ]);
      const lookup = makeAgentLookup([parent, child]);
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: lookup,
        getAgent: lookup,
      });
      const cb = makeCallbacks();

      await executeArchive(deps, "parent", cb);

      expect(cb.onComplete).toHaveBeenCalledWith(["parent", "child"]);
    });

    it("deletes plain (non-review) child agents too", async () => {
      const parent = makeAgent("parent");
      const child = makeAgent("child", {
        parentAgentId: "parent",
        role: "standard",
        status: "stopped",
      });

      const pool = makeChildQueryPool([
        { id: "child", parentAgentId: "parent" },
      ]);
      const lookup = makeAgentLookup([parent, child]);
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: lookup,
        getAgent: lookup,
      });
      const cb = makeCallbacks();

      await executeArchive(deps, "parent", cb);

      expect(cb.onComplete).toHaveBeenCalledWith(["parent", "child"]);
    });

    it("archives a child:true agent but spares a child:false one the same parent launched", async () => {
      const parent = makeAgent("parent");
      // child: true — parent_agent_id points back at the parent.
      const trueChild = makeAgent("true-child", {
        parentAgentId: "parent",
        launchedByAgentId: "parent",
        status: "stopped",
      });
      // child: false — launched by the same parent but deliberately
      // independent, so only launched_by_agent_id points back.
      const independent = makeAgent("independent", {
        parentAgentId: null,
        launchedByAgentId: "parent",
        status: "stopped",
      });

      const pool = makeChildQueryPool([
        { id: "true-child", parentAgentId: "parent" },
        { id: "independent", parentAgentId: null, launchedByAgentId: "parent" },
      ]);
      const lookup = makeAgentLookup([parent, trueChild, independent]);
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: lookup,
        getAgent: lookup,
      });
      const cb = makeCallbacks();

      await executeArchive(deps, "parent", cb);

      expect(cb.onComplete).toHaveBeenCalledWith(["parent", "true-child"]);
      expect(deletedAgentIds(pool)).not.toContain("independent");
    });

    it("reports grandchildren in the deleted set", async () => {
      const parent = makeAgent("parent");
      const child = makeAgent("child", {
        parentAgentId: "parent",
        status: "stopped",
      });
      const grandchild = makeAgent("grandchild", {
        parentAgentId: "child",
        role: "review",
        status: "stopped",
      });

      const pool = makeChildQueryPool([
        { id: "child", parentAgentId: "parent" },
        { id: "grandchild", parentAgentId: "child" },
      ]);
      const lookup = makeAgentLookup([parent, child, grandchild]);
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: lookup,
        getAgent: lookup,
      });
      const cb = makeCallbacks();

      await executeArchive(deps, "parent", cb);

      expect(cb.onComplete).toHaveBeenCalledWith([
        "parent",
        "child",
        "grandchild",
      ]);
    });

    it("skips a child that is already archiving itself", async () => {
      const parent = makeAgent("parent");
      const pool = makeChildQueryPool([]);
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(parent),
        getAgent: vi.fn().mockResolvedValue(parent),
      });
      const cb = makeCallbacks();

      await executeArchive(deps, "parent", cb);

      const childQuery = pool.query.mock.calls.find(
        ([sql]: [string]) =>
          typeof sql === "string" &&
          sql.includes("FROM agents") &&
          sql.includes("parent_agent_id")
      );
      expect(childQuery?.[0]).toContain("status != 'archiving'");
    });

    it("still completes when the child lookup fails after the parent is deleted", async () => {
      const parent = makeAgent("parent");
      const pool = makePool(async (sql: string) => {
        if (sql.includes("FROM agents") && sql.includes("parent_agent_id")) {
          throw new Error("connection reset");
        }
        return defaultQueryImpl(sql);
      });
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(parent),
        getAgent: vi.fn().mockResolvedValue(parent),
      });
      const cb = makeCallbacks();

      await executeArchive(deps, "parent", cb);

      expect(cb.onComplete).toHaveBeenCalledWith(["parent"]);
      expect(cb.onError).not.toHaveBeenCalled();
    });

    it("cleans up a cascaded child's worktree, same as the parent's", async () => {
      const parent = makeAgent("parent");
      const child = makeAgent("child", {
        parentAgentId: "parent",
        status: "stopped",
        worktreePath: "/tmp/wt-child",
        worktreeBranch: "agt/child",
      });

      const pool = makeChildQueryPool([
        { id: "child", parentAgentId: "parent" },
      ]);
      const lookup = makeAgentLookup([parent, child]);
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: lookup,
        getAgent: lookup,
      });

      await executeArchive(deps, "parent", makeCallbacks());

      // Leaving it behind would register a worktree no agent record can reach.
      expect(cleanupGitWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/tmp/wt-child", deleteBranch: true }),
        expect.any(Function)
      );
    });

    it("removes a cascaded child's worktree even when it holds work", async () => {
      const parent = makeAgent("parent");
      const child = makeAgent("child", {
        parentAgentId: "parent",
        status: "stopped",
        worktreePath: "/tmp/wt-child",
        worktreeBranch: "agt/child",
      });
      vi.mocked(observeGitCheckout).mockResolvedValue({
        ...cleanCheckout,
        uncommittedFiles: ["src/wip.ts"],
      });

      const pool = makeChildQueryPool([
        { id: "child", parentAgentId: "parent" },
      ]);
      const lookup = makeAgentLookup([parent, child]);
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: lookup,
        getAgent: lookup,
      });

      await executeArchive(deps, "parent", makeCallbacks());

      // The parent's confirmation answered for the whole cascade.
      expect(cleanupGitWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/tmp/wt-child" }),
        expect.any(Function)
      );
    });

    it.each([
      { ownership: "owned", online: true, release: true, pending: false },
      { ownership: "owned", online: false, release: false, pending: true },
      { ownership: "borrowed", online: true, release: false, pending: false },
    ] as const)(
      "archives a runner child according to its binding ($ownership, online $online)",
      async ({ ownership, online, release, pending }) => {
        const parent = makeAgent("parent");
        const child = makeAgent("child", {
          parentAgentId: parent.id,
          cwd: "/runner/checkout",
          placement: placementForRunner("runner"),
          runnerManaged: true,
        });
        const pool = makeChildQueryPool([
          { id: child.id, parentAgentId: parent.id },
        ]);
        const lookup = makeAgentLookup([parent, child]);
        const call = vi.fn(
          async (_runner: string, op: string, input: { session: string }) => {
            expect(input.session).toBe(child.id);
            if (op === "workspace.observe")
              return {
                ownership,
                owner: ownership === "owned" ? child.id : parent.id,
                borrowers: [],
                checkout: {
                  ...cleanCheckout,
                  uncommittedFiles: ["src/wip.ts"],
                },
              };
            if (op === "workspace.release") return { removed: true };
            throw new Error("Unexpected operation " + op);
          }
        );
        const callbacks = makeCallbacks();
        await executeArchive(
          makeDeps({
            pool: pool as never,
            getRequiredAgent: lookup,
            getAgent: lookup,
            remote: {
              call,
              connectionEpoch: () => (online ? 1 : undefined),
            } as never,
          }),
          parent.id,
          callbacks
        );
        expect(call.mock.calls.map(([, op]) => op)).toEqual(
          online
            ? release
              ? ["workspace.observe", "workspace.release"]
              : ["workspace.observe"]
            : []
        );
        expect(pool.query).toHaveBeenCalledWith(
          expect.stringContaining("runner_cleanup_pending = $2"),
          [child.id, pending]
        );
        expect(callbacks.onComplete).toHaveBeenCalledWith([
          parent.id,
          child.id,
        ]);
      }
    );

    it("clears child worktrees even when the parent's own is kept", async () => {
      // "keep" is an answer about the parent's own worktree.
      const parent = makeAgent("parent", {
        archiveCleanupMode: "keep",
        worktreePath: "/tmp/wt-parent",
        worktreeBranch: "agt/parent",
      });
      const child = makeAgent("child", {
        parentAgentId: "parent",
        status: "stopped",
        worktreePath: "/tmp/wt-child",
        worktreeBranch: "agt/child",
      });

      const pool = makeChildQueryPool([
        { id: "child", parentAgentId: "parent" },
      ]);
      const lookup = makeAgentLookup([parent, child]);
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: lookup,
        getAgent: lookup,
      });

      await executeArchive(deps, "parent", makeCallbacks());

      const cleaned = vi
        .mocked(cleanupGitWorktree)
        .mock.calls.map(([input]) => input.cwd);
      expect(cleaned).toContain("/tmp/wt-child");
      expect(cleaned).not.toContain("/tmp/wt-parent");
    });

    it("leaves a worktree alone when another live agent also references it", async () => {
      const parent = makeAgent("parent");
      const child = makeAgent("child", {
        parentAgentId: "parent",
        status: "stopped",
        worktreePath: "/tmp/wt-shared",
        worktreeBranch: "agt/shared",
      });

      const pool = makePool(async (sql: string, params?: unknown[]) => {
        if (sql.includes("worktree_path = $2")) {
          // A second live row points at the same worktree.
          return { rows: [{ id: "other" }], rowCount: 1 };
        }
        if (sql.includes("FROM agents") && sql.includes("parent_agent_id")) {
          return params?.[0] === "parent"
            ? { rows: [{ id: "child" }], rowCount: 1 }
            : { rows: [], rowCount: 0 };
        }
        return defaultQueryImpl(sql);
      });
      const lookup = makeAgentLookup([parent, child]);
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: lookup,
        getAgent: lookup,
      });
      const cb = makeCallbacks();

      await executeArchive(deps, "parent", cb);

      expect(cleanupGitWorktree).not.toHaveBeenCalled();
      // The agent records still go — only the worktree is spared.
      expect(cb.onComplete).toHaveBeenCalledWith(["parent", "child"]);
    });

    it.each(["cwd", "launch_cwd"] as const)(
      "preserves the parent's checkout for a failed standard child that references it through %s",
      async (column) => {
        const checkout = "/tmp/wt-parent";
        const parent = makeAgent("parent", {
          worktreePath: checkout,
          archiveCleanupMode: "force",
        });
        const child = makeAgent("child", {
          parentAgentId: parent.id,
          cwd: column === "cwd" ? checkout : "/tmp/wt-child",
          ...(column === "launch_cwd"
            ? { launchCwd: checkout, worktreePath: "/tmp/wt-child" }
            : {}),
        });
        let childFailed = false;
        const pool = makePool(async (sql: string, params?: unknown[]) => {
          if (
            sql.includes("parent_agent_id") &&
            sql.includes("FROM agents") &&
            params?.[0] === parent.id
          ) {
            return { rows: [{ id: child.id }], rowCount: 1 };
          }
          if (
            childFailed &&
            params?.[0] === parent.id &&
            (params[3] as string[] | undefined)?.includes(checkout) &&
            sql.includes(`OR ${column} = ANY($4::text[])`)
          ) {
            return { rows: [{ id: child.id }], rowCount: 1 };
          }
          return defaultQueryImpl(sql);
        });
        const lookup = makeAgentLookup([parent, child]);
        const deps = makeDeps({
          pool: pool as never,
          getRequiredAgent: lookup,
          getAgent: lookup,
        });
        const failure = new Error("database volume is in use");
        vi.mocked(runLifecycleHook)
          .mockResolvedValueOnce(undefined)
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(failure);
        vi.mocked(deps.setAgentStatus).mockImplementation(
          async (id, status) => {
            if (id === child.id && status === "error") childFailed = true;
          }
        );

        const callbacks = makeCallbacks();
        await executeArchive(deps, parent.id, callbacks);

        expect(deps.setAgentStatus).toHaveBeenCalledWith(
          child.id,
          "error",
          failure.message
        );
        expect(cleanupGitWorktree).not.toHaveBeenCalled();
        expect(callbacks.onComplete).toHaveBeenCalledWith([parent.id]);
        expect(deletedAgentIds(pool)).toEqual([parent.id]);

        await executeArchive(deps, child.id, callbacks);
        expect(callbacks.onComplete).toHaveBeenCalledWith([child.id]);
        expect(deletedAgentIds(pool)).toEqual([parent.id, child.id]);
      }
    );

    it("does not cascade when the agent has no children", async () => {
      const parent = makeAgent("parent");

      const pool = makeChildQueryPool([]);
      const deps = makeDeps({
        pool: pool as never,
        getRequiredAgent: vi.fn().mockResolvedValue(parent),
        getAgent: vi.fn().mockResolvedValue(parent),
      });
      const cb = makeCallbacks();

      await executeArchive(deps, "parent", cb);

      expect(cb.onComplete).toHaveBeenCalledWith(["parent"]);
    });

    it("continues if a child cascade fails", async () => {
      const parent = makeAgent("parent");

      const pool = makePool(async (sql: string, params?: unknown[]) => {
        if (sql.includes("FROM agents") && sql.includes("parent_agent_id")) {
          return params?.[0] === "parent"
            ? { rows: [{ id: "bad-child" }], rowCount: 1 }
            : { rows: [], rowCount: 0 };
        }
        return defaultQueryImpl(sql);
      });
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
      const pool = makePool();
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
      const pool = makePool();
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
      const pool = makePool();
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

  it("deletes a stopped agent without tearing down a host", async () => {
    const agent = makeAgent("a1", { status: "stopped" });
    const pool = makePool();
    const runtime = makeRuntime();
    const deps = makeDeps({
      pool: pool as never,
      runtime,
      getRequiredAgent: vi.fn().mockResolvedValue(agent),
    });

    await deleteAgentDirect(deps, "a1");

    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runLifecycleHook).toHaveBeenCalledExactlyOnceWith(
      "archive",
      agent,
      expect.anything(),
      expect.anything(),
      undefined
    );
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SET deleted_at = NOW()"),
      ["a1", false]
    );
  });

  it("stops the host directly rather than through stopAgent", async () => {
    const agent = makeAgent("a1", { status: "running" });
    const runtime = makeRuntime();
    const pool = makePool();
    const deps = makeDeps({
      pool: pool as never,
      runtime,
      getRequiredAgent: vi.fn().mockResolvedValue(agent),
    });

    await deleteAgentDirect(deps, "a1");

    // stopAgent would write `stopping`/`stopped` and release the claim.
    expect(runtime.stop).toHaveBeenCalledWith("a1", true);
    expect(deps.settleStream).toHaveBeenCalledWith("a1");
    expect(runtime.discard).toHaveBeenCalledWith("a1");
    expect(runLifecycleHook).toHaveBeenCalled();
    const statuses = pool.query.mock.calls
      .map(([sql]: [string]) => sql)
      .filter((sql: unknown) => typeof sql === "string");
    expect(statuses.some((sql: string) => sql.includes("'stopped'"))).toBe(
      false
    );
  });

  it("continues deletion even if the host teardown fails", async () => {
    const agent = makeAgent("a1", { status: "running" });
    const runtime = makeRuntime({
      stop: vi.fn().mockRejectedValue(new Error("stop failed")),
    });
    const pool = makePool();
    const deps = makeDeps({
      pool: pool as never,
      runtime,
      getRequiredAgent: vi.fn().mockResolvedValue(agent),
    });

    await deleteAgentDirect(deps, "a1");

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SET deleted_at = NOW()"),
      ["a1", false]
    );
  });

  it("cascades to child agents recursively", async () => {
    const parent = makeAgent("p1", { status: "stopped" });
    const child = makeAgent("c1", { status: "stopped", parentAgentId: "p1" });

    const pool = makePool(async (sql: string, params?: unknown[]) =>
      sql.includes("FROM agents") &&
      sql.includes("parent_agent_id") &&
      params?.[0] === "p1"
        ? { rows: [{ id: "c1" }], rowCount: 1 }
        : defaultQueryImpl(sql)
    );
    const deps = makeDeps({
      pool: pool as never,
      getRequiredAgent: vi.fn().mockImplementation(async (id: string) => {
        return id === "p1" ? parent : child;
      }),
    });

    await deleteAgentDirect(deps, "p1");

    const deleteCalls = pool.query.mock.calls.filter(
      ([sql]: [string]) =>
        typeof sql === "string" && sql.includes("SET deleted_at = NOW()")
    );
    expect(deleteCalls).toHaveLength(2);
  });

  it("skips an agent a concurrent archive already claimed", async () => {
    const parent = makeAgent("p1", { status: "running" });
    // The claim matches nothing: another archive got the row first.
    const pool = makePool(async (sql: string) =>
      isArchiveClaim(sql)
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id: "c1" }], rowCount: 1 }
    );
    const deps = makeDeps({
      pool: pool as never,
      getRequiredAgent: vi.fn().mockResolvedValue(parent),
    });

    const deleted = await deleteAgentDirect(deps, "p1");

    expect(deleted).toEqual([]);
    expect(deps.diffStatsRefresher?.clear).not.toHaveBeenCalled();
    expect(
      pool.query.mock.calls.some(
        ([sql]: [string]) =>
          typeof sql === "string" &&
          sql.includes("UPDATE agents") &&
          sql.includes("deleted_at = NOW()")
      )
    ).toBe(false);
  });

  it("claims the agent before stopping it", async () => {
    const agent = makeAgent("a1", { status: "running" });
    const pool = makePool();
    const order: string[] = [];
    pool.query.mockImplementation(async (sql: unknown) => {
      if (isArchiveClaim(sql)) order.push("claim");
      return defaultQueryImpl(sql);
    });
    const runtime = makeRuntime({
      stop: vi.fn().mockImplementation(async () => {
        order.push("stop");
      }),
    });
    const deps = makeDeps({
      pool: pool as never,
      runtime,
      getRequiredAgent: vi.fn().mockResolvedValue(agent),
    });

    await deleteAgentDirect(deps, "a1");

    expect(order).toEqual(["claim", "stop"]);
  });

  it("still reports itself when the child lookup fails after the delete", async () => {
    const parent = makeAgent("p1", { status: "stopped" });
    const pool = makePool(async (sql: string) => {
      if (sql.includes("FROM agents") && sql.includes("parent_agent_id")) {
        throw new Error("connection reset");
      }
      return defaultQueryImpl(sql);
    });
    const deps = makeDeps({
      pool: pool as never,
      getRequiredAgent: vi.fn().mockResolvedValue(parent),
    });

    await expect(deleteAgentDirect(deps, "p1")).resolves.toEqual(["p1"]);
  });

  it("clears diffStatsRefresher", async () => {
    const agent = makeAgent("a1", { status: "stopped" });
    const pool = makePool();
    const diffStatsRefresher = { clear: vi.fn() };
    const deps = makeDeps({
      pool: pool as never,
      diffStatsRefresher,
      getRequiredAgent: vi.fn().mockResolvedValue(agent),
    });

    await deleteAgentDirect(deps, "a1");

    expect(diffStatsRefresher.clear).toHaveBeenCalledWith("a1");
  });

  it("cascades to a child agent", async () => {
    const parent = makeAgent("p1", { status: "stopped" });
    const child = makeAgent("c1", {
      status: "stopped",
      parentAgentId: "p1",
    });

    const pool = makePool(async (sql: string, params?: unknown[]) =>
      sql.includes("FROM agents") &&
      sql.includes("parent_agent_id") &&
      params?.[0] === "p1"
        ? { rows: [{ id: "c1" }], rowCount: 1 }
        : defaultQueryImpl(sql)
    );
    const deps = makeDeps({
      pool: pool as never,
      getRequiredAgent: vi.fn().mockImplementation(async (id: string) => {
        return id === "p1" ? parent : child;
      }),
    });

    await deleteAgentDirect(deps, "p1");

    expect(deps.getRequiredAgent).toHaveBeenCalledWith("c1");
    const childDeleteCalls = pool.query.mock.calls.filter(
      ([sql, params]: [string, unknown[]?]) =>
        typeof sql === "string" &&
        sql.includes("SET deleted_at = NOW()") &&
        params?.[0] === "c1"
    );
    expect(childDeleteCalls).toHaveLength(1);
  });
});

it("archives an offline managed session with pending cleanup recorded in the same write", async () => {
  const runtime = makeRuntime({
    stop: vi.fn().mockRejectedValue(new Error("runner offline")),
  });
  const deps = makeDeps({
    runtime,
    getRequiredAgent: vi.fn().mockResolvedValue(
      makeAgent("remote", {
        cwd: "/runner/sessions/checkout",
        placement: placementForRunner("runner"),
        runnerManaged: true,
        status: "archiving",
      })
    ),
  });
  const onComplete = vi.fn();
  await executeArchive(deps, "remote", {
    onComplete,
    onPhaseChange: vi.fn(),
    onError: vi.fn(),
  });
  expect(runtime.discard).not.toHaveBeenCalled();
  expect(deps.pool.query).toHaveBeenCalledWith(
    expect.stringContaining("runner_cleanup_pending = $2"),
    ["remote", true]
  );
  expect(onComplete).toHaveBeenCalledWith(["remote"]);
});
