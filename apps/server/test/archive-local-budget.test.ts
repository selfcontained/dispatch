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
import { cleanupAgentWorktree } from "../src/agents/archive.js";
import { workspaceWorkload } from "../src/agents/checkout-worker.js";
import { runnerDirectory } from "../src/runners/directory.js";
import { controllerPlacement } from "../src/runners/placement.js";

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

/** A child that owns the worktree; its release is `release`. */
function owningChild(release: () => Promise<unknown>) {
  const call = vi.fn(async (op: string, input: { path?: string }) => {
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
    if (op === "workspace.release") return release();
    throw new Error(`unexpected ${op}`);
  });
  const child = {
    connection: { state: "ready", epoch: 1, onChange: () => () => {} },
    call,
  } as unknown as Runner;
  return { child, call };
}

function archive(child: Runner) {
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
    outcome: cleanupAgentWorktree(
      pool,
      logger,
      { bindWorkspace: async () => false },
      agent(),
      "force",
      undefined,
      runner
    ),
  };
}

it("force reads no checkout state before removing, as main", async () => {
  const { child, call } = owningChild(async () => ({ removed: true }));
  const { outcome } = archive(child);
  expect(await outcome).toEqual({ kind: "released" });
  // The archive's own calls: the co-owner spelling, then the removal. The
  // adapter checks the child owns the worktree before removing it.
  expect(call.mock.calls.map(([op]) => op)).toEqual([
    "path.resolve",
    "workspace.describe",
    "workspace.observe",
    "workspace.release",
  ]);
});

it("keeps a checkout whose removal outlasts main's 60 s, with main's warning", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const here = vi.spyOn(workspaceWorkload, "release");
  const { child, call } = owningChild(() => new Promise(() => {}));
  const { outcome, logger } = archive(child);
  let settled: unknown;
  void outcome.then((value) => (settled = value));
  await vi.advanceTimersByTimeAsync(59_000);
  expect(settled).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await outcome).toEqual({ kind: "kept", reason: "failed" });
  expect(logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({
      err: expect.objectContaining({
        message: "Worktree cleanup timed out after 60000ms",
      }),
      worktreePath: worktree,
    }),
    "Worktree cleanup failed; leaving on disk."
  );
  // Sent once; nothing is made again here.
  expect(
    call.mock.calls.filter(([op]) => op === "workspace.release")
  ).toHaveLength(1);
  expect(here).not.toHaveBeenCalled();
  here.mockRestore();
});
