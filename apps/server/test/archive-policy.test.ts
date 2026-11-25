import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";
import type {
  CheckoutObservation,
  CheckoutRelease,
} from "@dispatch/runner-protocol";
import {
  RunnerCallError,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupAgentWorktree,
  finishCheckout,
  type ArchiveDeps,
} from "../src/agents/archive.js";
import {
  archiveRunner,
  releaseRemoteCheckout,
} from "../src/agents/archive-checkout.js";
import { runnerArchiveExecutor } from "../src/agents/archive-policy.js";
import { workspaceWorkload } from "../src/agents/checkout-worker.js";
import { observeGitCheckout } from "../src/agents/checkout-inspection.js";
import { createLocalRunner } from "../src/agents/local-runner.js";
import { controllerPlacement } from "../src/runners/placement.js";
import type { RemoteRunnerService } from "../src/agents/remote/service.js";
import type { AgentRecord, WorktreeCleanupMode } from "../src/agents/types.js";

/** The local runner's removal port itself, before any test wraps it. */
const port = workspaceWorkload.release.bind(workspaceWorkload);

let fixture: string;
let repo: string;
let checkout: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

beforeEach(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  fixture = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "archive-policy-"))
  );
  repo = path.join(fixture, "origin");
  checkout = path.join(fixture, "worktree");
  execFileSync("mkdir", [repo]);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(path.join(repo, "README.md"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  git(repo, "worktree", "add", "-q", "-b", "feature", checkout);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(fixture, { recursive: true, force: true });
});

const MODES = ["auto", "keep", "force"] as const;
/**
 * clean/dirty/unmerged: the checkout as observed. missing: the directory is
 * gone. changed: the dialog's stored snapshot no longer matches. race: the
 * checkout changes between observation and release.
 */
const STATES = [
  "clean",
  "dirty",
  "unmerged",
  "missing",
  "changed",
  "race",
] as const;
type State = (typeof STATES)[number];

type Row = {
  placement: "local" | "runner";
  mode: WorktreeCleanupMode;
  state: State;
  borrowed: boolean;
};

type Result = {
  pending: boolean;
  removed: boolean;
  /** Persisted for the retry when pending. */
  rememberedState: string | null;
};

/** Main's observation of the row's worktree: its own, with Git's state. */
async function observeRow(): Promise<CheckoutObservation> {
  return {
    ownership: "owned",
    owner: "agent-fixture",
    borrowers: [],
    checkout: await observeGitCheckout(checkout).catch(() => null),
  };
}

function shape(state: State) {
  if (state === "dirty") writeFileSync(path.join(checkout, "draft.txt"), "x");
  if (state === "unmerged") {
    writeFileSync(path.join(checkout, "draft.txt"), "x");
    git(checkout, "add", "draft.txt");
    git(checkout, "commit", "-qm", "unmerged");
  }
  if (state === "missing") rmSync(checkout, { recursive: true, force: true });
}

type Harness = {
  deps: ArchiveDeps;
  agent: AgentRecord;
  db: { checkoutState: string | null; cleanupMode: string | null };
};

function harness(
  row: Row,
  options: {
    offline?: boolean;
    branchCoOwner?: boolean;
    releaseError?: boolean;
    child?: Runner;
    /** The row records no worktree of its own. */
    rowWithoutWorktree?: boolean;
    /** The row records this path as its worktree instead. */
    rowWorktree?: string;
  } = {}
): Harness {
  const logger = {
    warn: vi.fn(),
    info: vi.fn(),
  } as unknown as FastifyBaseLogger;
  const local = createLocalRunner(path.join(fixture, "hosts"), logger);
  const binding = {
    id: "agent-fixture",
    cwd: repo,
    worktreePath: checkout,
    worktreeBranch: "feature",
    baseBranch: "main",
  };
  const db = {
    checkoutState:
      row.state === "changed" ? "1".repeat(64) : (null as string | null),
    cleanupMode: null as string | null,
  };
  // The local runner's removal port, failing or racing as the row asks.
  vi.spyOn(workspaceWorkload, "release").mockImplementation(async (...args) => {
    if (options.releaseError) throw new Error("release failed");
    if (row.state === "race")
      writeFileSync(path.join(checkout, "late.txt"), "late");
    return port(...args);
  });
  const localRunner = local;
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes("SET archive_checkout_state"))
        db.checkoutState = params[1] as string;
      if (sql.includes("SET archive_cleanup_mode = 'keep'"))
        db.cleanupMode = "keep";
      if (sql.includes("worktree_branch = $") && options.branchCoOwner)
        return { rows: [{ id: "co-owner" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  // Mirrors the runner supervisor: a null or stale authorization retains,
  // a live borrower defers, otherwise the checkout is removed.
  const remote = {
    requestSession: async (
      _placement: unknown,
      request: { operation: CheckoutRelease }
    ) => {
      if (options.offline) throw new Error("Runner is offline.");
      const { operation } = request;
      if (operation.kind === "observe") {
        const observation: CheckoutObservation = {
          ...(await observeRow()),
          borrowers: row.borrowed ? ["borrower"] : [],
        };
        return { value: JSON.stringify(observation) };
      }
      if (operation.expectedState === null) return { value: "retained" };
      if (options.releaseError) throw new Error("release failed");
      if (row.state === "race")
        writeFileSync(path.join(checkout, "late.txt"), "late");
      const current = await observeRow();
      if (current.checkout?.stateId !== operation.expectedState)
        return { value: "retained" };
      if (row.borrowed) return { value: "inUse" };
      await port(
        "agent-fixture",
        { path: checkout },
        { deleteBranch: true, originalBranch: "feature" }
      );
      return { value: "released" };
    },
  } as unknown as RemoteRunnerService;
  const agent = {
    ...binding,
    ...(options.rowWithoutWorktree && {
      worktreePath: null,
      worktreeBranch: null,
    }),
    ...(options.rowWorktree && { worktreePath: options.rowWorktree }),
    cwd: row.placement === "runner" ? "runner://test/@session" : repo,
    placement: controllerPlacement,
    runnerManaged: row.placement === "runner",
  } as unknown as AgentRecord;
  const deps = {
    pool,
    logger,
    localRunner,
    remote,
    localRunnerChild: () => options.child,
  } as unknown as ArchiveDeps;
  return { deps, agent, db };
}

async function archive(
  row: Row,
  options: Parameters<typeof harness>[1] & { stopped?: boolean } = {}
): Promise<Result> {
  shape(row.state);
  const { deps, agent, db } = harness(row, options);
  const pending = await finishCheckout(
    deps,
    agent,
    row.mode,
    options.stopped ?? true,
    {}
  );
  return {
    pending,
    removed: !existsSync(checkout),
    rememberedState: pending ? db.checkoutState : null,
  };
}

function expected(row: Row): Omit<Result, "rememberedState"> {
  if (row.state === "missing") return { pending: false, removed: true };
  const authorizes =
    row.mode === "force" ||
    (row.mode === "auto" && ["clean", "changed", "race"].includes(row.state));
  if (!authorizes) return { pending: false, removed: false };
  if (row.placement === "runner") {
    if (row.state === "race") return { pending: false, removed: false };
    if (row.borrowed) return { pending: true, removed: false };
  }
  return { pending: false, removed: true };
}

const ROWS: Row[] = (["local", "runner"] as const).flatMap((placement) =>
  MODES.flatMap((mode) =>
    STATES.flatMap((state) =>
      [false, true].map((borrowed) => ({ placement, mode, state, borrowed }))
    )
  )
);

describe("archive checkout outcome table", () => {
  it.each(ROWS)("$placement $mode $state borrowed=$borrowed", async (row) => {
    const result = await archive(row);
    expect({ pending: result.pending, removed: result.removed }).toEqual(
      expected(row)
    );
    // A deferred release keeps the authorization it observed.
    if (result.pending)
      expect(result.rememberedState).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(ROWS.filter(({ placement }) => placement === "local"))(
    "child $mode $state borrowed=$borrowed",
    async (row) => {
      const identity = await workspaceWorkload.identity(checkout);
      const call = vi.fn(async (op, input) => {
        if (op === "path.resolve")
          return workspaceWorkload.resolvePath(input.path, input);
        if (op === "workspace.describe") return { checkoutRoot: checkout };
        if (op === "workspace.observe") return observeRow();
        expect(op).toBe("workspace.release");
        expect(input).toEqual({
          session: "agent-fixture",
          deleteBranch: true,
          originalBranch: "feature",
        });
        if (row.state === "race")
          writeFileSync(path.join(checkout, "late.txt"), "late");
        return {
          removed: await workspaceWorkload.release(
            "agent-fixture",
            { path: checkout, identity: identity! },
            input
          ),
        };
      });
      const result = await archive(row, {
        child: {
          call,
          connection: { state: "ready", epoch: 1, onChange: () => () => {} },
        } as unknown as Runner,
      });
      expect(result).toEqual({ ...expected(row), rememberedState: null });
      const release =
        row.mode === "force" ||
        (row.mode === "auto" && !["dirty", "unmerged"].includes(row.state));
      expect(call.mock.calls.map(([op]) => op)).toEqual([
        // The co-owner check spells the worktree path first, as main does.
        "path.resolve",
        // Auto observes through the child: it holds the row's worktree.
        ...(row.mode === "auto"
          ? ["workspace.describe", "workspace.observe"]
          : []),
        ...(release
          ? ["workspace.describe", "workspace.observe", "workspace.release"]
          : []),
      ]);
      if (release)
        expect(git(repo, "branch", "--list", "feature") === "").toBe(
          row.state !== "missing"
        );
    }
  );

  it("keeps an unreadable worktree whose release reply was lost, as main keeps a failed cleanup", async () => {
    if (process.getuid?.() === 0) return; // root reads any folder
    const row = {
      placement: "local",
      mode: "force",
      state: "clean",
      borrowed: false,
    } as const;
    shape(row.state);
    const call = vi.fn(async (op: string, input: { path: string }) => {
      if (op === "path.resolve")
        return workspaceWorkload.resolvePath(input.path, input);
      if (op === "workspace.describe")
        return { path: checkout, checkoutRoot: checkout, moved: false };
      if (op === "workspace.observe")
        return {
          ownership: "owned",
          owner: "agent-fixture",
          borrowers: [],
          checkout: null,
        };
      if (op === "workspace.release") {
        // The child went with its reply, and the worktree cannot be read.
        chmodSync(fixture, 0o000);
        throw new RunnerCallError({
          code: "unknown_outcome",
          message: "The local runner went away",
        });
      }
      throw new RunnerCallError({ code: "not_found", message: op });
    });
    const { deps, agent } = harness(row, {
      child: {
        call,
        connection: { state: "ready", epoch: 1, onChange: () => () => {} },
      } as unknown as Runner,
    });
    const release = vi.spyOn(workspaceWorkload, "release");
    try {
      expect(await finishCheckout(deps, agent, row.mode, true, {})).toBe(false);
    } finally {
      chmodSync(fixture, 0o755);
    }
    expect(existsSync(checkout)).toBe(true);
    expect(release).not.toHaveBeenCalled();
    expect(
      call.mock.calls.filter(([op]) => op === "workspace.release")
    ).toHaveLength(1);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: checkout }),
      "Worktree cleanup failed; leaving on disk."
    );
  });

  it("uses the in-process cleanup when the local child has no binding", async () => {
    const call = vi.fn(async (op: string, input: { path: string }) => {
      if (op === "path.resolve")
        return workspaceWorkload.resolvePath(input.path, input);
      throw new RunnerCallError({
        code: "not_found",
        message: "No checkout is bound to this session",
      });
    });
    const result = await archive(
      { placement: "local", mode: "force", state: "clean", borrowed: false },
      {
        child: {
          call,
          connection: { state: "ready", epoch: 1, onChange: () => () => {} },
        } as unknown as Runner,
      }
    );
    expect(result.removed).toBe(true);
    expect(
      call.mock.calls.filter(([op]) => op === "workspace.describe")
    ).toEqual([
      // One attempt: a child that cannot answer is not waited for.
      [
        "workspace.describe",
        { session: "agent-fixture" },
        expect.objectContaining({ wait: false, timeoutMs: null }),
      ],
    ]);
  });

  it("preserves another linked checkout swapped into the owned path", async () => {
    const identity = await workspaceWorkload.identity(checkout);
    const other = path.join(fixture, "other");
    git(repo, "worktree", "add", "-qb", "other", other);
    rmSync(checkout, { recursive: true });
    symlinkSync(other, checkout, "dir");
    expect(
      await workspaceWorkload.release(
        "agent-fixture",
        { path: checkout, identity: identity! },
        { deleteBranch: true, originalBranch: "feature" }
      )
    ).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(git(other, "branch", "--show-current")).toBe("other");
  });

  it("keeps a runner release pending while the runner is offline", async () => {
    const row = {
      placement: "runner",
      mode: "auto",
      state: "clean",
      borrowed: false,
    } as const;
    expect(await archive(row, { offline: true })).toMatchObject({
      pending: true,
      removed: false,
    });
  });

  it("keeps a runner release pending while its host did not stop", async () => {
    const row = {
      placement: "runner",
      mode: "force",
      state: "dirty",
      borrowed: false,
    } as const;
    expect(await archive(row, { stopped: false })).toMatchObject({
      pending: true,
      removed: false,
    });
  });

  it("leaves a local checkout without retry when release fails", async () => {
    const row = {
      placement: "local",
      mode: "force",
      state: "clean",
      borrowed: false,
    } as const;
    expect(await archive(row, { releaseError: true })).toMatchObject({
      pending: false,
      removed: false,
    });
  });

  it("keeps a runner release pending when release fails", async () => {
    const row = {
      placement: "runner",
      mode: "force",
      state: "clean",
      borrowed: false,
    } as const;
    expect(await archive(row, { releaseError: true })).toMatchObject({
      pending: true,
      removed: false,
    });
  });
});

describe("main's local automatic cleanup", () => {
  const auto = {
    placement: "local",
    mode: "auto",
    state: "clean",
    borrowed: false,
  } as const;

  it("keeps a clean switched branch with work outside main despite the recorded base", async () => {
    shape("unmerged");
    git(repo, "branch", "release", "feature");
    git(repo, "branch", "pre-existing", "release");
    git(checkout, "switch", "pre-existing");
    const h = harness(auto);
    h.agent.baseBranch = "release";
    const observation = await observeRow();
    expect(observation.checkout).toMatchObject({
      unmerged: true,
      uncommittedFiles: [],
    });
    expect(await finishCheckout(h.deps, h.agent, auto.mode, true, {})).toBe(
      false
    );
    expect(existsSync(checkout)).toBe(true);
    expect(git(repo, "branch", "--list", "pre-existing")).toContain(
      "pre-existing"
    );
    expect(git(repo, "branch", "--list", "feature")).toContain("feature");
  });

  it("removes a worktree carrying commits when the comparison base is gone", async () => {
    shape("unmerged");
    git(repo, "branch", "-m", "main", "trunk");
    expect(await archive(auto)).toMatchObject({
      removed: true,
      pending: false,
    });
    expect(git(repo, "branch", "--list", "feature")).toBe("");
  });

  it("removes a worktree whose commits add and then remove the same file", async () => {
    shape("unmerged");
    git(checkout, "rm", "draft.txt");
    git(checkout, "commit", "-qm", "revert");
    expect(await archive(auto)).toMatchObject({
      removed: true,
      pending: false,
    });
    expect(git(repo, "branch", "--list", "feature")).toBe("");
  });

  it.each([false, true])(
    "ignores a failed status check while honoring committed changes=%s",
    async (unmerged) => {
      if (unmerged) shape("unmerged");
      const index = path.resolve(
        checkout,
        git(checkout, "rev-parse", "--git-path", "index")
      );
      writeFileSync(index, Buffer.alloc(16, 7));
      expect(await archive(auto)).toMatchObject({
        removed: !unmerged,
        pending: false,
      });
      expect(Boolean(git(repo, "branch", "--list", "feature"))).toBe(unmerged);
    }
  );
});

/** The call `retryRunnerCleanup` makes for a pending row. */
function retry(h: Harness, row: Row) {
  const mode = (h.db.cleanupMode ?? row.mode) as WorktreeCleanupMode;
  return row.placement === "runner"
    ? releaseRemoteCheckout(
        h.deps.pool,
        h.deps.logger,
        h.agent,
        mode,
        h.deps.remote,
        true
      )
    : cleanupAgentWorktree(
        h.deps.pool,
        h.deps.logger,
        h.deps.localRunner,
        h.agent,
        mode
      );
}

describe("restored worktree_branch co-owner guard", () => {
  it.each(["auto", "force"] as const)(
    "keeps a local %s checkout whose branch another live agent records",
    async (mode) => {
      const row = {
        placement: "local",
        mode,
        state: "clean",
        borrowed: false,
      } as const;
      const h = harness(row, { branchCoOwner: true });
      expect(
        await cleanupAgentWorktree(
          h.deps.pool,
          h.deps.logger,
          h.deps.localRunner,
          h.agent,
          mode,
          undefined,
          archiveRunner(undefined, h.agent, controllerPlacement)
        )
      ).toEqual({ kind: "kept", reason: "coOwner" });
      expect(existsSync(checkout)).toBe(true);
      expect(git(repo, "branch", "--list", "feature")).toContain("feature");
    }
  );

  it("keeps for a co-owner even when an ordinary borrower is present", async () => {
    const row = {
      placement: "local",
      mode: "force",
      state: "clean",
      borrowed: true,
    } as const;
    const h = harness(row, { branchCoOwner: true });
    expect(
      await cleanupAgentWorktree(
        h.deps.pool,
        h.deps.logger,
        h.deps.localRunner,
        h.agent,
        "force",
        undefined,
        archiveRunner(undefined, h.agent, controllerPlacement)
      )
    ).toEqual({ kind: "kept", reason: "coOwner" });
  });
});

describe("negotiated archive release", () => {
  it.each([
    { mode: "force", liveCoOwner: false, ownership: "owned", removes: true },
    { mode: "force", liveCoOwner: true, ownership: "owned", removes: false },
    {
      mode: "force",
      liveCoOwner: false,
      ownership: "external",
      removes: false,
    },
    { mode: "auto", liveCoOwner: false, ownership: "owned", removes: false },
    { mode: "keep", liveCoOwner: false, ownership: "owned", removes: false },
  ] as const)(
    "retries $mode against a capable peer ($ownership, co-owner=$liveCoOwner)",
    async ({ mode, ownership, liveCoOwner, removes }) => {
      const row = {
        placement: "runner",
        mode,
        state: "dirty",
        borrowed: false,
      } as const;
      const { deps, agent, db } = harness(row, {
        offline: true,
        branchCoOwner: liveCoOwner,
      });
      expect(await finishCheckout(deps, agent, mode, true, {})).toBe(true);
      expect(db.checkoutState).toBeNull();

      writeFileSync(path.join(checkout, "late.txt"), "written while offline");
      const requestSession = vi.fn(async (_placement, request) => {
        if (request.kind === "checkoutRelease") {
          expect(request.operation).toEqual({
            kind: "observe",
            policy: mode === "force" ? "ownership" : "changes",
          });
          return {
            value: JSON.stringify({
              ownership,
              owner: ownership === "owned" ? agent.id : null,
              borrowers: ["borrower"],
              checkout:
                mode === "force"
                  ? null
                  : {
                      path: checkout,
                      branch: "feature",
                      stateId: "0".repeat(64),
                      unmerged: false,
                      changedFiles: [],
                      uncommittedFiles: ["late.txt"],
                    },
            }),
          };
        }
        expect(request).toMatchObject({
          kind: "workspaceRelease",
          agentId: agent.id,
          operation: { deleteBranch: true, originalBranch: "feature" },
        });
        expect(request.operation).not.toHaveProperty("expectedState");
        const removed = await workspaceWorkload.release(
          agent.id,
          { path: checkout },
          request.operation
        );
        return { value: JSON.stringify({ removed }) };
      });
      deps.remote = {
        supportsWorkspaceRelease: () => true,
        requestSession,
      } as unknown as RemoteRunnerService;
      expect(await finishCheckout(deps, agent, mode, true, {})).toBe(false);
      expect(existsSync(checkout)).toBe(!removes);
      expect(db.checkoutState).toBeNull();
      expect(
        requestSession.mock.calls.map(([, request]) => request.kind)
      ).toEqual(
        mode === "keep"
          ? []
          : removes
            ? ["checkoutRelease", "workspaceRelease"]
            : ["checkoutRelease"]
      );
    }
  );
});

describe("a gone runner checkout", () => {
  it("archives with auto and releases it, as main archives a missing worktree", async () => {
    const row = {
      placement: "runner",
      mode: "auto",
      state: "clean",
      borrowed: false,
    } as const;
    const { deps, agent } = harness(row);
    git(repo, "worktree", "remove", "--force", checkout);
    const requestSession = vi.fn(async (_placement, request) => {
      if (request.kind === "checkoutRelease")
        return {
          value: JSON.stringify({
            ownership: "owned",
            owner: agent.id,
            borrowers: [],
            checkout: null,
          }),
        };
      expect(request).toMatchObject({
        kind: "workspaceRelease",
        agentId: agent.id,
      });
      return { value: JSON.stringify({ removed: true }) };
    });
    deps.remote = {
      supportsWorkspaceRelease: () => true,
      requestSession,
    } as unknown as RemoteRunnerService;
    expect(await finishCheckout(deps, agent, "auto", true, {})).toBe(false);
    expect(requestSession.mock.calls.map(([, r]) => r.kind)).toEqual([
      "checkoutRelease",
      "workspaceRelease",
    ]);
  });
});

describe("pending release retry", () => {
  const firstAttempts = ROWS.filter(
    (row) => !row.borrowed && expected({ ...row, borrowed: true }).pending
  );

  it.each(firstAttempts)(
    "$placement $mode $state: a borrowed release retries to the first-attempt outcome",
    async (row) => {
      shape(row.state);
      const borrowed = harness({ ...row, borrowed: true });
      expect(
        await finishCheckout(borrowed.deps, borrowed.agent, row.mode, true, {})
      ).toBe(true);
      expect(existsSync(checkout)).toBe(true);
      // The borrower has gone; the retry makes a fresh observation.
      const free = harness(row);
      free.db.checkoutState = borrowed.db.checkoutState;
      const outcome = await retry(free, row);
      expect({
        pending: outcome.kind === "pending",
        removed: !existsSync(checkout),
      }).toEqual(expected(row));
    }
  );

  it.each(["auto", "keep", "force"] as const)(
    "runner %s: an offline release retries to the first-attempt outcome",
    async (mode) => {
      const row = {
        placement: "runner",
        mode,
        state: "dirty",
        borrowed: false,
      } as const;
      shape(row.state);
      const offline = harness(row, { offline: true });
      expect(
        await finishCheckout(offline.deps, offline.agent, mode, true, {})
      ).toBe(true);
      const online = harness(row);
      online.db = offline.db;
      const outcome = await retry(online, row);
      expect({
        pending: outcome.kind === "pending",
        removed: !existsSync(checkout),
      }).toEqual(expected(row));
    }
  );

  it("reevaluates a pending force cleanup at retry and removes late edits", async () => {
    const row = {
      placement: "runner",
      mode: "force",
      state: "clean",
      borrowed: false,
    } as const;
    const borrowed = harness({ ...row, borrowed: true });
    expect(
      await finishCheckout(borrowed.deps, borrowed.agent, "force", true, {})
    ).toBe(true);
    writeFileSync(path.join(checkout, "later.txt"), "later");
    const free = harness(row);
    free.db.checkoutState = borrowed.db.checkoutState;
    expect((await retry(free, row)).kind).toBe("released");
    expect(existsSync(checkout)).toBe(false);
  });
});

/*
 * Local archive by main's rule (`git show origin/main:apps/server/src/agents/
 * archive.ts`): the row's `worktree_path` is the agent's worktree; with no
 * co-owner it is removed when the mode authorizes it (force, or auto with no
 * outstanding work), whatever the local runner child holds. The child acts
 * only when its binding agrees with the row; otherwise the same removal runs
 * in process.
 */
describe("local archive against main's outcomes, whatever the child holds", () => {
  type Held = {
    at: () => string;
    ownership: "owned" | "gone" | "external";
  } | null;

  /** A local runner child holding `held` for the session, or dying on every call. */
  function child(held: Held, dies = false) {
    const call = vi.fn(async (op: string, input: never) => {
      if (dies)
        throw new RunnerCallError({
          code: "unavailable",
          message: "The local runner is unavailable",
        });
      if (op === "path.resolve") {
        const request = input as unknown as { path: string };
        return workspaceWorkload.resolvePath(request.path, request);
      }
      if (!held)
        throw new RunnerCallError({
          code: "not_found",
          message: "No checkout is bound to this session",
        });
      const at = held.at();
      switch (op) {
        case "workspace.describe":
          return {
            path: at,
            moved: false,
            origin: null,
            checkoutRoot: at,
            branch: null,
            worktree: null,
          };
        case "workspace.observe":
          return held.ownership === "external"
            ? {
                ownership: "external",
                owner: null,
                borrowers: [],
                checkout: null,
              }
            : {
                ownership: "owned",
                owner: "agent-fixture",
                borrowers: [],
                checkout:
                  held.ownership === "gone"
                    ? null
                    : await observeGitCheckout(at).catch(() => null),
              };
        case "workspace.release":
          if (held.ownership === "external") return { removed: false };
          if (held.ownership === "gone") return { removed: true };
          return {
            removed: await workspaceWorkload.release(
              "agent-fixture",
              { path: at },
              input
            ),
          };
      }
      throw new Error(`unexpected ${op}`);
    });
    return {
      call,
      connection: { state: "ready", epoch: 1, onChange: () => () => {} },
    } as unknown as Runner;
  }
  const auto = {
    placement: "local",
    mode: "auto",
    state: "clean",
    borrowed: false,
  } as const;
  const atRow = () => checkout;

  it("owned at the row's worktree: removed", async () => {
    expect(
      await archive(auto, { child: child({ at: atRow, ownership: "owned" }) })
    ).toMatchObject({ pending: false, removed: true });
    expect(git(repo, "branch", "--list", "feature")).toBe("");
  });

  it("gone at the row's worktree: released", async () => {
    expect(
      await archive(
        { ...auto, state: "missing" },
        { child: child({ at: atRow, ownership: "gone" }) }
      )
    ).toMatchObject({ pending: false, removed: true });
  });

  // The child's import said external: main still removes the row's worktree.
  it("external at the row's worktree: removed, as main does", async () => {
    expect(
      await archive(auto, {
        child: child({ at: atRow, ownership: "external" }),
      })
    ).toMatchObject({ pending: false, removed: true });
  });

  it("a binding elsewhere than the row's worktree: the row's worktree is removed", async () => {
    expect(
      await archive(auto, {
        child: child({ at: () => repo, ownership: "external" }),
      })
    ).toMatchObject({ pending: false, removed: true });
    expect(existsSync(repo)).toBe(true);
  });

  it("a row without a worktree of its own: nothing is removed, even if the child owns one", async () => {
    expect(
      await archive(
        { ...auto, mode: "force" },
        {
          child: child({ at: atRow, ownership: "owned" }),
          rowWithoutWorktree: true,
        }
      )
    ).toMatchObject({ pending: false, removed: false });
  });

  // Main hands the row's path to cleanupGitWorktree, which removes the
  // checkout root Git resolves for it (`rev-parse --show-toplevel`).
  it.each([
    ["force", "no child", null],
    ["auto", "no child", null],
    ["force", "a child holding the worktree root", "root"],
  ] as const)(
    "a row naming a subdirectory of its worktree (%s, %s): the worktree is removed, as main does",
    async (mode, _child, held) => {
      const sub = path.join(checkout, "src");
      execFileSync("mkdir", [sub]);
      writeFileSync(path.join(sub, ".keep"), "");
      git(checkout, "add", ".");
      git(checkout, "commit", "-qm", "src");
      // Merged, so auto finds nothing outstanding.
      git(repo, "merge", "-q", "--ff-only", "feature");
      expect(
        await archive(
          { ...auto, mode },
          {
            rowWorktree: sub,
            ...(held && {
              child: child({ at: atRow, ownership: "owned" }),
            }),
          }
        )
      ).toMatchObject({ pending: false, removed: true });
      expect(git(repo, "branch", "--list", "feature")).toBe("");
    }
  );

  it("dirty under auto: kept", async () => {
    expect(
      await archive(
        { ...auto, state: "dirty" },
        { child: child({ at: atRow, ownership: "owned" }) }
      )
    ).toMatchObject({ pending: false, removed: false });
  });

  it("shared with a live sibling: kept", async () => {
    expect(
      await archive(
        { ...auto, mode: "force" },
        {
          child: child({ at: atRow, ownership: "owned" }),
          branchCoOwner: true,
        }
      )
    ).toMatchObject({ pending: false, removed: false });
  });

  it("no child yet: removed in process", async () => {
    expect(await archive(auto)).toMatchObject({
      pending: false,
      removed: true,
    });
  });

  it("no binding in the child: removed in process", async () => {
    expect(await archive(auto, { child: child(null) })).toMatchObject({
      pending: false,
      removed: true,
    });
  });

  it("a child that dies mid-call: removed in process", async () => {
    expect(
      await archive(auto, {
        child: child({ at: atRow, ownership: "owned" }, true),
      })
    ).toMatchObject({ pending: false, removed: true });
  });
});

describe("runner archive co-owner, whatever the row's worktree path", () => {
  it("decides as it did when runner rows carried no worktree path", async () => {
    const decide = async (worktreePath: string | null) => {
      const pool = {
        // A row that moved into the runner checkout matches only by path.
        query: async (_sql: string, params: unknown[]) =>
          params[3] !== null && params[3] === "/workload/checkout"
            ? { rows: [{ id: "moved-in" }], rowCount: 1 }
            : { rows: [], rowCount: 0 },
      } as unknown as Pool;
      const remote = {
        supportsWorkspaceRelease: () => true,
        requestSession: async () => ({ value: "released" }),
      } as unknown as RemoteRunnerService;
      const executor = runnerArchiveExecutor(
        {
          id: "runner-agent",
          cwd: "runner://test/@session",
          worktreePath,
          worktreeBranch: null,
          baseBranch: null,
        },
        remote,
        true,
        pool
      );
      return executor.observedCoOwner!({
        ownership: "owned",
        owner: "runner-agent",
        borrowers: [],
        checkout: null,
      });
    };
    expect(await decide("/workload/checkout")).toBe(await decide(null));
  });
});
