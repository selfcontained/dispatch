/*
 * The one archive entry decides by the archive policy the composition gives
 * the runner, never by the row: a runner row that records a worktree path
 * (a runner-prepared checkout shows its folder on the row) still gets the
 * enrolled policy, and a local row main's. Each outcome is the one the two
 * executors gave before the seam (N35 records both policies).
 */
import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";
import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import { describe, expect, it, vi } from "vitest";
import { archiveCheckout, type ArchiveRunner } from "../src/agents/archive.js";
import type { ArchiveOutcome } from "../src/agents/archive-policy.js";
import {
  enrolledArchivePolicy,
  localArchivePolicy,
  runnerDirectory,
} from "../src/runners/directory.js";
import {
  controllerPlacement,
  placementForRunner,
} from "../src/runners/placement.js";
import type { RemoteRunnerService } from "../src/agents/remote/service.js";
import type { WorktreeCleanupMode } from "../src/agents/types.js";

type Checkout = "clean" | "dirty" | "unreadable" | "gone";
type Fixture = {
  ownership?: "owned" | "borrowed" | "none";
  checkout?: Checkout;
  statusFailure?: string;
  borrowers?: string[];
  /** What the release does. */
  release?: "removes" | "unknown_outcome" | "failed";
  /** Another live row the co-owner rules would find. */
  coOwner?: boolean;
};

const CLEAN = {
  path: "/checkout",
  branch: "feature",
  stateId: "0".repeat(64),
  unmerged: false,
  changedFiles: [],
  uncommittedFiles: [] as string[],
};

function fixtureRunner(policy: "local" | "enrolled", f: Fixture = {}) {
  const call = vi.fn(async (op: string, input?: { policy?: string }) => {
    if (op === "path.resolve")
      return { canonicalPath: "/checkout", exists: true };
    if (op === "workspace.observe") {
      if (
        input?.policy !== "ownership" &&
        (f.checkout === "unreadable" || f.statusFailure)
      )
        throw new RunnerCallError({
          code: f.statusFailure === "Git timeout" ? "timeout" : "failed",
          message: f.statusFailure ?? "unreadable",
        });
      return {
        ownership: f.ownership ?? "owned",
        owner: (f.ownership ?? "owned") === "owned" ? "agt_a" : null,
        borrowers: f.borrowers ?? [],
        checkout:
          f.checkout === "dirty"
            ? { ...CLEAN, uncommittedFiles: ["draft.txt"] }
            : f.checkout === "gone"
              ? null
              : CLEAN,
      };
    }
    if (op === "session.retire") {
      if (f.release === "unknown_outcome" || f.release === "failed")
        throw new RunnerCallError({ code: f.release, message: "discard" });
      return {};
    }
    if (op === "workspace.release") {
      if (f.release === "unknown_outcome" || f.release === "failed")
        throw new RunnerCallError({ code: f.release, message: "release" });
      return { removed: true };
    }
    throw new Error(`unexpected ${op}`);
  });
  const runner = {
    call,
    connection: { state: "ready" },
    archive: policy === "local" ? localArchivePolicy : enrolledArchivePolicy,
    ...(policy === "local" && { cleanupBudgetMs: 60_000 }),
  } as unknown as ArchiveRunner;
  return { runner, call };
}

function run(
  policy: "local" | "enrolled",
  mode: WorktreeCleanupMode,
  f: Fixture = {},
  row: { worktreePath?: string | null; cwd?: string } = {},
  stopped = true
) {
  const { runner, call } = fixtureRunner(policy, f);
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      return f.coOwner && sql.includes("SELECT id")
        ? { rows: [{ id: "agt_co" }] }
        : { rows: [] };
    },
  } as unknown as Pool;
  const logger = { warn: vi.fn(), info: vi.fn() };
  const agent = {
    id: "agt_a",
    cwd: row.cwd ?? (policy === "local" ? "/repo" : "/srv/checkout"),
    worktreePath:
      row.worktreePath === undefined ? "/checkout" : row.worktreePath,
    worktreeBranch: "feature",
    baseBranch: "main",
  };
  const outcome = archiveCheckout(
    pool,
    logger as unknown as FastifyBaseLogger,
    agent,
    mode,
    stopped,
    {},
    runner
  );
  return {
    outcome,
    call,
    ops: () => call.mock.calls.map(([op]) => op),
    logger,
    queries,
  };
}

const released: ArchiveOutcome = { kind: "released" };
const kept = (reason: string) => ({ kind: "kept", reason });
const pending = (reason: string) => ({ kind: "pending", reason });

describe("one archive policy", () => {
  it("both directory entries use the same policy object", () => {
    const directory = runnerDirectory({ remote: {} as RemoteRunnerService });
    expect(directory.for(controllerPlacement).archive).toBe(localArchivePolicy);
    expect(directory.for(placementForRunner("runner-a")).archive).toBe(
      localArchivePolicy
    );
    expect(enrolledArchivePolicy).toBe(localArchivePolicy);
    expect(localArchivePolicy).toEqual({
      coOwner: "observed",
      borrowers: "observed",
      forceSkipsObserve: false,
      failure: "pending",
      awaitsStoppedHost: true,
    });
  });
});
describe.each(["local", "enrolled"] as const)("%s policy", (placement) => {
  it.each([
    ["clean", "auto", {}, released],
    ["dirty", "auto", { checkout: "dirty" }, kept("notAuthorized")],
    ["dirty forced", "force", { checkout: "dirty" }, released],
    ["unreadable forced", "force", { checkout: "unreadable" }, released],
    ["gone", "auto", { checkout: "gone" }, released],
    ["borrowed", "force", { ownership: "borrowed" }, kept("notAuthorized")],
    ["borrower", "force", { borrowers: ["child"] }, pending("borrowed")],
    ["co-owner", "force", { coOwner: true }, pending("borrowed")],
    [
      "uncertain release",
      "force",
      { release: "unknown_outcome" },
      pending("unavailable"),
    ],
    ["failed release", "force", { release: "failed" }, pending("unavailable")],
    ["keep", "keep", {}, kept("notAuthorized")],
  ] as const)("%s", async (_name, mode, f, outcome) => {
    const result = run(placement, mode, f as Fixture);
    expect(await result.outcome).toEqual(outcome);
    if ("ownership" in f && f.ownership === "borrowed")
      expect(result.ops()).toEqual(["workspace.observe"]);
    expect(result.ops()).not.toContain("path.resolve");
  });
  it("force observes ownership even when the DB row records no worktree", async () => {
    const result = run(placement, "force", {}, { worktreePath: null });
    expect(await result.outcome).toEqual(released);
    expect(result.call.mock.calls[0]).toEqual([
      "workspace.observe",
      { session: "agt_a", policy: "ownership" },
    ]);
  });
  it.each([
    "Git error",
    "Git timeout",
    "unreadable .git",
    "runner observation failed",
  ])("%s stays retryable and never becomes keep", async (statusFailure) => {
    const result = run(placement, "auto", { statusFailure });
    expect(await result.outcome).toEqual(pending("unavailable"));
    expect(result.ops()).not.toContain("workspace.release");
    expect(
      result.queries.some((sql) =>
        sql.includes("archive_cleanup_mode = 'keep'")
      )
    ).toBe(false);
    expect(result.logger.warn).toHaveBeenCalledWith(
      expect.anything(),
      "Runner checkout release remains pending."
    );
  });
  it("waits for a confirmed stopped host", async () => {
    const result = run(placement, "force", {}, {}, false);
    expect(await result.outcome).toEqual(pending("unavailable"));
    expect(result.ops()).toEqual([]);
  });
});
