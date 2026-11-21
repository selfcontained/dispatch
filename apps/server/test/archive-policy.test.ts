import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupAgentWorktree,
  finishCheckout,
  type ArchiveDeps,
} from "../src/agents/archive.js";
import { releaseRemoteCheckout } from "../src/agents/archive-checkout.js";
import { cascadeMode } from "../src/agents/archive-policy.js";
import { createLocalRunner } from "../src/agents/local-runner.js";
import type { RemoteRunnerService } from "../src/agents/remote/service.js";
import type { AgentRecord, WorktreeCleanupMode } from "../src/agents/types.js";

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
  const release = async (operation: CheckoutRelease) => {
    if (options.releaseError) throw new Error("release failed");
    if (row.state === "race")
      writeFileSync(path.join(checkout, "late.txt"), "late");
    return local.checkoutRelease(
      binding,
      operation as Extract<CheckoutRelease, { kind: "release" }>
    );
  };
  const localRunner = {
    ...local,
    checkoutRelease: ((b: typeof binding, operation: CheckoutRelease) =>
      operation.kind === "observe"
        ? local.checkoutRelease(b, operation)
        : release(operation)) as typeof local.checkoutRelease,
  };
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes("SELECT archive_checkout_state"))
        return { rows: [{ archive_checkout_state: db.checkoutState }] };
      if (sql.includes("SET archive_checkout_state"))
        db.checkoutState = params[1] as string;
      if (sql.includes("SET archive_cleanup_mode = 'keep'"))
        db.cleanupMode = "keep";
      if (sql.includes("workspace_path = ANY") && row.borrowed)
        return {
          rows: [{ id: "borrower", worktreePath: null, workspacePath: null }],
          rowCount: 1,
        };
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
        const observed = await local.checkoutRelease(binding, operation);
        const observation: CheckoutObservation = {
          ...observed,
          borrowers: row.borrowed ? ["borrower"] : [],
        };
        return { value: JSON.stringify(observation) };
      }
      if (operation.expectedState === null) return { value: "retained" };
      if (row.borrowed) {
        const current = await local.checkoutRelease(binding, {
          kind: "observe",
        });
        if (current.checkout?.stateId !== operation.expectedState)
          return { value: "retained" };
        return { value: "inUse" };
      }
      return { value: await release(operation) };
    },
  } as unknown as RemoteRunnerService;
  const agent = {
    ...binding,
    cwd: row.placement === "runner" ? "runner://test/@session" : repo,
    runnerManaged: row.placement === "runner",
  } as unknown as AgentRecord;
  const deps = {
    pool,
    logger,
    localRunner,
    remote,
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

/** Today's outcome. Identical on both placements for every row. */
function expected(row: Row): Omit<Result, "rememberedState"> {
  const authorizes =
    row.mode !== "keep" &&
    row.state !== "missing" &&
    row.state !== "changed" &&
    (row.mode === "force" || row.state === "clean" || row.state === "race");
  if (row.state === "missing") return { pending: false, removed: true };
  if (!authorizes) return { pending: false, removed: false };
  if (row.borrowed) return { pending: true, removed: false };
  if (row.state === "race") return { pending: false, removed: false };
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
          mode
        )
      ).toEqual({ kind: "kept", reason: "coOwner" });
      expect(existsSync(checkout)).toBe(true);
      expect(git(repo, "branch", "--list", "feature")).toContain("feature");
    }
  );

  it("still defers to a live borrower before the guard", async () => {
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
        "force"
      )
    ).toEqual({ kind: "pending", reason: "borrowed" });
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
      // The borrower has gone; the retry reuses the remembered authorization.
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

  it("keeps a pending checkout that changed before the retry", async () => {
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
    for (const placement of ["runner", "local"] as const) {
      const free = harness({ ...row, placement });
      free.db.checkoutState = borrowed.db.checkoutState;
      expect((await retry(free, { ...row, placement })).kind).toBe("kept");
      expect(existsSync(checkout)).toBe(true);
    }
  });
});

describe("cascadeMode", () => {
  it("keeps each placement's current cascade rule", () => {
    expect(cascadeMode("local")).toBe("force");
    expect(cascadeMode("runner")).toBe("auto");
  });
});
