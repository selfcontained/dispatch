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

describe("the composition gives each runner its archive policy", () => {
  it("local is main's rule; an enrolled runner's is N35", () => {
    const directory = runnerDirectory({
      remote: {} as RemoteRunnerService,
    });
    expect(directory.for(controllerPlacement).archive).toBe(localArchivePolicy);
    expect(directory.for(placementForRunner("runner-a")).archive).toBe(
      enrolledArchivePolicy
    );
    expect(localArchivePolicy).toEqual({
      coOwner: "recorded",
      borrowers: "recorded",
      forceSkipsObserve: true,
      failure: "kept",
      awaitsStoppedHost: false,
    });
    expect(enrolledArchivePolicy).toEqual({
      coOwner: "observed",
      borrowers: "observed",
      forceSkipsObserve: false,
      failure: "pending",
      awaitsStoppedHost: true,
    });
  });
});

describe("a runner-prepared worktree row that records its folder", () => {
  const row = { worktreePath: "/runner/checkout" };

  it("still observes ownership on force, and keeps a borrowed checkout", async () => {
    const borrowed = run("enrolled", "force", { ownership: "borrowed" }, row);
    expect(await borrowed.outcome).toEqual(kept("notAuthorized"));
    expect(borrowed.ops()).toEqual(["workspace.observe"]);
  });

  it("keeps the checkout a live review borrower holds (the runner's borrower list)", async () => {
    const reviewed = run(
      "enrolled",
      "force",
      { borrowers: ["agt_review"], coOwner: true },
      row
    );
    expect(await reviewed.outcome).toEqual(kept("coOwner"));
    expect(reviewed.ops()).toEqual(["workspace.observe"]);
    // N35's rule, not main's: no path spelling, no recorded-worktree query.
    expect(reviewed.ops()).not.toContain("path.resolve");
  });

  it("releases an owned checkout on force with the runner's decision", async () => {
    const owned = run("enrolled", "force", {}, row);
    expect(await owned.outcome).toEqual(released);
    expect(owned.ops()).toEqual(["workspace.observe", "workspace.release"]);
  });
});

describe("what an enrolled archive asks the runner to observe", () => {
  it.each([
    ["force", { session: "agt_a", policy: "ownership" }],
    ["auto", { session: "agt_a" }],
  ] as const)("%s", async (mode, request) => {
    const enrolled = run("enrolled", mode);
    await enrolled.outcome;
    const observes = enrolled.call.mock.calls.filter(
      ([op]) => op === "workspace.observe"
    );
    expect(observes.map(([, input]) => input)).toEqual([request]);
  });
});

describe("a local row gets main's rule", () => {
  it("force reads no checkout state, only the co-owner spelling", async () => {
    const forced = run("local", "force", { checkout: "dirty" });
    expect(await forced.outcome).toEqual(released);
    expect(forced.ops()).toEqual(["path.resolve", "workspace.release"]);
  });

  it("a recorded co-owner keeps it, before anything is observed", async () => {
    const shared = run("local", "force", { coOwner: true });
    expect(await shared.outcome).toEqual(kept("coOwner"));
    expect(shared.ops()).toEqual(["path.resolve"]);
  });

  it("a row that records no worktree is not managed", async () => {
    const plain = run("local", "force", {}, { worktreePath: null });
    expect(await plain.outcome).toEqual(kept("notManaged"));
    expect(plain.ops()).toEqual([]);
  });
});

describe.each([
  // [case, mode, fixture, local outcome, enrolled outcome]
  ["clean", "auto", {}, released, released],
  [
    "dirty",
    "auto",
    { checkout: "dirty" },
    kept("notAuthorized"),
    kept("notAuthorized"),
  ],
  ["dirty, forced", "force", { checkout: "dirty" }, released, released],
  [
    "status unreadable, forced",
    "force",
    { checkout: "unreadable" },
    released,
    released,
  ],
  ["gone checkout", "auto", { checkout: "gone" }, released, released],
  [
    "borrowed",
    "auto",
    { ownership: "borrowed" },
    kept("notAuthorized"),
    kept("notAuthorized"),
  ],
  [
    "uncertain release",
    "force",
    { release: "unknown_outcome" },
    kept("failed"),
    pending("unavailable"),
  ],
  [
    "runner-reported failure",
    "force",
    { release: "failed" },
    kept("failed"),
    pending("unavailable"),
  ],
  ["keep", "keep", {}, kept("notAuthorized"), kept("notAuthorized")],
] as const)("%s", (_name, mode, fixture, local, enrolled) => {
  it("local: main's outcome", async () => {
    expect(await run("local", mode, fixture as Fixture).outcome).toEqual(local);
  });
  it("enrolled: N35's outcome", async () => {
    expect(await run("enrolled", mode, fixture as Fixture).outcome).toEqual(
      enrolled
    );
  });
});

describe.each(["local", "enrolled"] as const)(
  "%s status failure",
  (placement) => {
    it.each([
      "Git error",
      "Git timeout",
      "unreadable .git",
      "runner observation failed",
    ])(
      "retains on %s and force skips the status read",
      async (statusFailure) => {
        const auto = run(placement, "auto", { statusFailure });
        expect(await auto.outcome).toEqual(kept("failed"));
        expect(auto.ops()).not.toContain("workspace.release");
        expect(auto.queries).toContain(
          "UPDATE agents SET archive_cleanup_mode = 'keep', archive_checkout_state = NULL WHERE id = $1"
        );
        expect(auto.logger.warn).toHaveBeenCalledWith(
          expect.anything(),
          "Worktree cleanup failed; leaving on disk."
        );
        const forced = run(placement, "force", { statusFailure });
        expect(await forced.outcome).toEqual(released);
      }
    );
  }
);

describe("failures and the host", () => {
  it("logs each policy's own warning", async () => {
    const local = run("local", "force", { release: "failed" });
    await local.outcome;
    expect(local.logger.warn).toHaveBeenCalledWith(
      expect.anything(),
      "Worktree cleanup failed; leaving on disk."
    );
    const enrolled = run("enrolled", "force", { release: "failed" });
    await enrolled.outcome;
    expect(enrolled.logger.warn).toHaveBeenCalledWith(
      expect.anything(),
      "Runner checkout release remains pending."
    );
  });

  it("an enrolled runner waits for the stopped host; local does not", async () => {
    const live = run("enrolled", "force", {}, {}, false);
    expect(await live.outcome).toEqual(pending("unavailable"));
    expect(live.ops()).toEqual([]);
    expect(await run("local", "force", {}, {}, false).outcome).toEqual(
      released
    );
  });

  it("only local carries main's cleanup budget", () => {
    expect(fixtureRunner("local").runner.cleanupBudgetMs).toBe(60_000);
    expect(fixtureRunner("enrolled").runner.cleanupBudgetMs).toBeUndefined();
  });
});
