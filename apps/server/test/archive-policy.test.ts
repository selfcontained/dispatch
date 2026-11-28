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
import {
  RunnerCallError,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { finishCheckout, type ArchiveDeps } from "../src/agents/archive.js";
import { workspaceWorkload } from "../../../packages/runner/src/workload/agents/checkout-worker.js";
import { observeGitCheckout } from "../../../packages/runner/src/workload/agents/checkout-inspection.js";
import {
  controllerPlacement,
  placementForRunner,
} from "../src/runners/placement.js";
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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(fixture, { recursive: true, force: true });
});

// The former tests pinned controller-side cleanup even when the child disowned
// a checkout. The common policy trusts runner ownership and never falls back to
// deleting the row's path. Both transports below use the real Git release port.
const clean = async () => ({
  ownership: "owned",
  owner: "agent-fixture",
  borrowers: [] as string[],
  checkout: existsSync(checkout) ? await observeGitCheckout(checkout) : null,
});
function fixtureRunner(
  kind: "local" | "runner",
  options: {
    ownership?: "owned" | "external" | "borrowed" | "none";
    borrowers?: string[];
    observeError?: string;
    releaseError?: string;
    retireError?: string;
    ready?: boolean;
    coOwner?: boolean;
    stopped?: boolean;
  } = {}
) {
  const calls: { op: string; input: any }[] = [];
  const call = vi.fn(async (op: string, input: any) => {
    calls.push({ op, input });
    if (op === "workspace.observe") {
      if (options.observeError)
        throw new RunnerCallError({
          code: options.observeError as never,
          message: "observe",
        });
      const observed = await clean();
      return {
        ...observed,
        ownership: options.ownership ?? "owned",
        owner:
          options.ownership === "external" || options.ownership === "none"
            ? null
            : options.ownership === "borrowed"
              ? "other"
              : "agent-fixture",
        borrowers: options.borrowers ?? [],
        ...(options.ownership &&
          options.ownership !== "owned" && { checkout: null }),
      };
    }
    if (op === "session.retire") {
      if (options.retireError)
        throw new RunnerCallError({
          code: options.retireError as never,
          message: "retire",
        });
      return {};
    }
    if (op === "workspace.release") {
      if (options.releaseError)
        throw new RunnerCallError({
          code: options.releaseError as never,
          message: "release",
        });
      return {
        removed: await workspaceWorkload.release(
          "agent-fixture",
          { path: checkout },
          input
        ),
      };
    }
    throw new Error(`Unexpected archive operation ${op}`);
  });
  const pool = {
    query: vi.fn(async (sql: string) =>
      options.coOwner && sql.includes("SELECT id")
        ? { rows: [{ id: "other" }] }
        : { rows: [] }
    ),
  } as unknown as Pool;
  const logger = {
    warn: vi.fn(),
    info: vi.fn(),
  } as unknown as FastifyBaseLogger;
  const runtime = { clearRemoteState: vi.fn() };
  const child = {
    call,
    connection: {
      state: options.ready === false ? "unavailable" : "ready",
      epoch: 1,
      onChange: () => () => {},
    },
  } as unknown as Runner;
  const remote = {
    call: (_id: string, op: string, input: any) => call(op, input),
    connectionEpoch: () => (options.ready === false ? undefined : 1),
  } as unknown as RemoteRunnerService;
  const agent = {
    id: "agent-fixture",
    cwd: repo,
    worktreePath: checkout,
    worktreeBranch: "feature",
    baseBranch: "main",
    placement:
      kind === "local" ? controllerPlacement : placementForRunner("fixture"),
  } as AgentRecord;
  const deps = {
    pool,
    logger,
    runtime,
    localRunnerChild: () => child,
    remote,
  } as unknown as ArchiveDeps;
  return {
    calls,
    call,
    pool,
    runtime,
    agent,
    run: (mode: WorktreeCleanupMode) =>
      finishCheckout(deps, agent, mode, options.stopped !== false, {}),
  };
}

describe.each(["local", "runner"] as const)(
  "%s observed archive policy",
  (kind) => {
    it.each(["auto", "keep", "force"] as const)(
      "%s clean checkout and branch",
      async (mode) => {
        const f = fixtureRunner(kind);
        expect(await f.run(mode)).toBe(false);
        expect(existsSync(checkout)).toBe(mode === "keep");
        expect(git(repo, "branch", "--list", "feature") !== "").toBe(
          mode === "keep"
        );
        expect(f.calls.at(-1)).toEqual({
          op: "session.retire",
          input: { session: "agent-fixture" },
        });
        expect(f.runtime.clearRemoteState).toHaveBeenCalledWith(
          "agent-fixture"
        );
      }
    );
    it.each(["dirty", "unmerged"] as const)(
      "auto retains %s; force removes",
      async (state) => {
        writeFileSync(path.join(checkout, "draft.txt"), "draft");
        if (state === "unmerged") {
          git(checkout, "add", ".");
          git(checkout, "commit", "-qm", "unlanded");
        }
        const f = fixtureRunner(kind);
        expect(await f.run("auto")).toBe(false);
        expect(existsSync(checkout)).toBe(true);
        expect(f.calls.map((c) => c.op)).toEqual([
          "workspace.observe",
          "session.retire",
        ]);
        expect(await f.run("force")).toBe(false);
        expect(existsSync(checkout)).toBe(false);
      }
    );
    it.each(["external", "borrowed"] as const)(
      "never removes a %s checkout, including force",
      async (ownership) => {
        const f = fixtureRunner(kind, { ownership });
        expect(await f.run("force")).toBe(false);
        expect(existsSync(checkout)).toBe(true);
        expect(f.calls.some((c) => c.op === "workspace.release")).toBe(false);
        expect(f.calls.at(-1)?.op).toBe("session.retire");
      }
    );
    it("observes ownership without a Git status read for force", async () => {
      const f = fixtureRunner(kind);
      expect(await f.run("force")).toBe(false);
      expect(f.calls[0]).toEqual({
        op: "workspace.observe",
        input: { session: "agent-fixture", policy: "ownership" },
      });
    });
    it.each(["borrower", "co-owner"] as const)(
      "defers removal for a live %s, but retires host state",
      async (hold) => {
        const f = fixtureRunner(
          kind,
          hold === "borrower" ? { borrowers: ["child"] } : { coOwner: true }
        );
        expect(await f.run("force")).toBe(true);
        expect(existsSync(checkout)).toBe(true);
        expect(f.calls.map((c) => c.op)).toEqual([
          "workspace.observe",
          "session.retire",
        ]);
        expect(f.calls.at(-1)?.input.checkoutPending).toBe(true);
        expect(f.runtime.clearRemoteState).not.toHaveBeenCalled();
      }
    );
    it.each([
      "failed",
      "timeout",
      "unavailable",
      "not_found",
      "unknown_outcome",
    ])(
      "observation %s remains pending, never becomes keep",
      async (observeError) => {
        const f = fixtureRunner(kind, { observeError });
        expect(await f.run("auto")).toBe(true);
        expect(existsSync(checkout)).toBe(true);
        expect(f.calls.map((c) => c.op)).toEqual([
          "workspace.observe",
          "session.retire",
        ]);
        expect(f.pool.query).not.toHaveBeenCalledWith(
          expect.stringContaining("archive_cleanup_mode = 'keep'"),
          expect.anything()
        );
      }
    );
    it.each(["failed", "unknown_outcome", "fenced"])(
      "release %s is not retried or rerun in the controller",
      async (releaseError) => {
        const f = fixtureRunner(kind, { releaseError });
        expect(await f.run("force")).toBe(true);
        expect(existsSync(checkout)).toBe(true);
        expect(
          f.calls.filter((c) => c.op === "workspace.release")
        ).toHaveLength(1);
        expect(f.calls.at(-1)?.input.checkoutPending).toBe(true);
      }
    );
    it("retries host retirement even after checkout release has completed", async () => {
      const f = fixtureRunner(kind, { retireError: "unavailable" });
      expect(await f.run("force")).toBe(true);
      expect(existsSync(checkout)).toBe(false);
      expect(f.runtime.clearRemoteState).not.toHaveBeenCalled();
    });
    it.each([false, true])(
      "does not release before the host is stopped (ready=%s)",
      async (ready) => {
        const f = fixtureRunner(kind, { ready, stopped: false });
        expect(await f.run("force")).toBe(true);
        expect(f.calls).toEqual([]);
        expect(existsSync(checkout)).toBe(true);
      }
    );

    it("keeps a switched branch with unlanded work despite the recorded base", async () => {
      writeFileSync(path.join(checkout, "draft.txt"), "draft");
      git(checkout, "add", ".");
      git(checkout, "commit", "-qm", "unlanded");
      git(repo, "branch", "release", "feature");
      git(repo, "branch", "pre-existing", "release");
      git(checkout, "switch", "pre-existing");
      const f = fixtureRunner(kind);
      f.agent.baseBranch = "release";
      expect(await f.run("auto")).toBe(false);
      expect(existsSync(checkout)).toBe(true);
      expect(git(repo, "branch", "--list", "pre-existing")).toContain(
        "pre-existing"
      );
      expect(git(repo, "branch", "--list", "feature")).toContain("feature");
    });
    it.each(["missing base", "reverted diff"] as const)(
      "preserves automatic cleanup for %s",
      async (state) => {
        writeFileSync(path.join(checkout, "draft.txt"), "draft");
        git(checkout, "add", ".");
        git(checkout, "commit", "-qm", "unlanded");
        if (state === "missing base")
          git(repo, "branch", "-m", "main", "trunk");
        else {
          git(checkout, "rm", "draft.txt");
          git(checkout, "commit", "-qm", "revert");
        }
        const f = fixtureRunner(kind);
        expect(await f.run("auto")).toBe(false);
        expect(existsSync(checkout)).toBe(false);
        expect(git(repo, "branch", "--list", "feature")).toBe("");
      }
    );
    it.each(["metadata", "index", "index with commits"])(
      "retries unreadable %s without losing checkout or branch",
      async (state) => {
        if (state === "metadata")
          writeFileSync(path.join(checkout, ".git"), "invalid metadata");
        else {
          if (state === "index with commits") {
            writeFileSync(path.join(checkout, "draft.txt"), "draft");
            git(checkout, "add", ".");
            git(checkout, "commit", "-qm", "unlanded");
          }
          const index = path.resolve(
            checkout,
            git(checkout, "rev-parse", "--git-path", "index")
          );
          writeFileSync(index, Buffer.alloc(16, 7));
        }
        const f = fixtureRunner(kind);
        expect(await f.run("auto")).toBe(true);
        expect(existsSync(checkout)).toBe(true);
        expect(git(repo, "branch", "--list", "feature")).toContain("feature");
        expect(f.calls.some((c) => c.op === "workspace.release")).toBe(false);
      }
    );
    it("releases a checkout whose directory is already gone", async () => {
      rmSync(checkout, { recursive: true, force: true });
      const f = fixtureRunner(kind);
      expect(await f.run("auto")).toBe(false);
      expect(f.calls.map((c) => c.op)).toEqual([
        "workspace.observe",
        "workspace.release",
        "session.retire",
      ]);
    });
  }
);
