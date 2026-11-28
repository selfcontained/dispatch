/*
 * Main's local archive, pinned through the local runner adapter: `force`
 * reads no checkout state before removing, and a removal that does not
 * finish within main's 60 s budget leaves the checkout on disk with main's
 * warning, sent once and never run again here.
 */
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";
import type { Runner } from "@dispatch/runner-protocol/contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { archiveCheckout } from "../src/agents/archive.js";
import { workspaceWorkload } from "../../../packages/runner/src/workload/agents/checkout-worker.js";
import { runnerDirectory } from "../src/runners/directory.js";
import {
  controllerPlacement,
  placementForRunner,
} from "../src/runners/placement.js";

let root: string;
let worktree: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "archive-budget-")));
  worktree = path.join(root, "worktree");
  await mkdir(worktree);
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

const agent = () => ({
  id: "agt_budget",
  cwd: root,
  worktreePath: worktree,
  worktreeBranch: "budget-branch",
  baseBranch: "main",
  workspacePath: null,
  placement: controllerPlacement,
});

/**
 * A live child that owns the worktree; `slow` never answers. The adapter
 * waits on its slow read as main waits on its own, until the budget.
 */
function owningChild(slow?: string) {
  const call = vi.fn(async (op: string, input: { path?: string }) => {
    if (op === slow) return new Promise(() => {});
    if (op === "path.resolve")
      return workspaceWorkload.resolvePath(input.path!, input);
    if (op === "workspace.describe")
      return { path: worktree, checkoutRoot: worktree, moved: false };
    if (op === "workspace.observe")
      return {
        ownership: "owned",
        owner: "agt_budget",
        borrowers: [],
        checkout: null,
      };
    if (op === "workspace.release") return { removed: true };
    throw new Error(`unexpected ${op}`);
  });
  const child = {
    connection: { state: "ready", epoch: 1, onChange: () => () => {} },
    call,
  } as unknown as Runner;
  return { child, call };
}

function archive(child: Runner, mode: "force" | "auto" = "force") {
  const logger = {
    warn: vi.fn(),
    info: vi.fn(),
  } as unknown as FastifyBaseLogger;
  const pool = {
    query: async () => ({ rows: [], rowCount: 0 }),
  } as unknown as Pool;
  const runner = runnerDirectory({ child: () => child }, agent()).for(
    controllerPlacement
  );
  return {
    logger,
    outcome: archiveCheckout(
      pool,
      logger,
      agent(),
      mode,
      true,
      undefined,
      runner
    ),
  };
}

it("force reads ownership but no checkout state before removing", async () => {
  const { child, call } = owningChild();
  const { outcome } = archive(child);
  expect(await outcome).toEqual({ kind: "released" });
  // The archive's own calls: the co-owner spelling, then the removal. The
  // adapter checks the child's binding names the worktree before removing it.
  expect(call.mock.calls.map(([op]) => op)).toEqual([
    "workspace.observe",
    "workspace.release",
  ]);
});

it.each([
  ["the ownership read", "workspace.observe", "force"],
  ["the observation", "workspace.observe", "auto"],
  ["the removal", "workspace.release", "force"],
] as const)(
  "retries a checkout when %s outlasts the 60 s cleanup budget",
  async (_, slow, mode) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const here = vi.spyOn(workspaceWorkload, "release");
    const { child, call } = owningChild(slow);
    const { outcome, logger } = archive(child, mode);
    let settled: unknown;
    void outcome.then((value) => (settled = value));
    // Main's budget runs from the start of the cleanup.
    await vi.advanceTimersByTimeAsync(59_000);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await outcome).toEqual({ kind: "pending", reason: "unavailable" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({
          message: "Worktree cleanup timed out after 60000ms",
        }),
        worktreePath: worktree,
      }),
      "Runner checkout release remains pending."
    );
    // Nothing is sent twice, and nothing is made here.
    expect(
      call.mock.calls.filter(([op]) => op === "workspace.release").length
    ).toBeLessThanOrEqual(1);
    expect(here).not.toHaveBeenCalled();
    here.mockRestore();
  }
);

it("distinguishes a gone checkout root from a failed Git read at an existing root", async () => {
  await expect(workspaceWorkload.observe(worktree)).rejects.toThrow();
  await rm(worktree, { recursive: true });
  expect(await workspaceWorkload.observe(worktree)).toBeNull();
});

it.each(["auto", "force"] as const)(
  "does not release after a late %s observation",
  async (mode) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { child, call } = owningChild();
    const serve = call.getMockImplementation()!;
    const deferred = Promise.withResolvers<void>();
    call.mockImplementation(async (op, input) => {
      if (op === "workspace.observe") await deferred.promise;
      return serve(op, input);
    });
    const { outcome, logger } = archive(child, mode);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await outcome).toEqual({ kind: "pending", reason: "unavailable" });
    deferred.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(call.mock.calls.map(([op]) => op)).not.toContain(
      "workspace.release"
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
  }
);

it("gives an enrolled runner no cleanup budget: its transport bounds it", () => {
  const enrolled = runnerDirectory({}).for(placementForRunner("enrolled-1"));
  expect(enrolled.cleanupBudgetMs).toBeUndefined();
  expect(runnerDirectory({}).for(controllerPlacement).cleanupBudgetMs).toBe(
    60_000
  );
});
