/*
 * The platform port: what the runner core asks of the machine it runs on.
 * One core, two platforms (`posix-user`, `linux-privsep`). `workload` and
 * `workspace` exist so far; process, layout and private-state parts arrive
 * with the families that need them.
 */
import type { Req, Res } from "@dispatch/runner-protocol/contract";

/**
 * Checkout reads a platform runs as the workload account. On `posix-user`
 * that is a direct function call in the runner's own process; on
 * `linux-privsep` it is one self-exec of the worker entry under the
 * workload's identity. They write nothing, so a frozen runner serves them.
 */
export const WORKER_OPS = [
  "checkout.list",
  "checkout.preview",
  "checkout.index",
  "checkout.read",
  "checkout.stats",
  "checkout.diff",
  "checkout.changes",
  "git.context",
] as const;

/** Commands the workload runs. They may write, so the fence refuses them. */
export const EXEC_OPS = ["checkout.exec"] as const;

export type WorkerOp = (typeof WORKER_OPS)[number];
export type ExecOp = (typeof EXEC_OPS)[number];
export type WorkloadOp = WorkerOp | ExecOp;

/** Which of a session's checkouts a target selected. */
export type Selector = "current" | "launch" | "moved";

/**
 * A workload operation's input: the request without its target, and the
 * directory the core resolved the target to. The workload never sees a
 * session handle, and the core never touches the directory itself. A
 * command also gets the selector, since a command in the current checkout
 * runs at that checkout's root and one in a named checkout runs in it.
 */
export type WorkerInput<K extends WorkloadOp> = {
  directory: string;
  request: Omit<Req<K>, "target">;
} & (K extends ExecOp ? { selector: Selector } : unknown) &
  (K extends "git.context" ? { checkoutBranch?: string } : unknown);

export type RunOptions = { signal?: AbortSignal };

export interface Workload {
  run<K extends WorkloadOp>(
    op: K,
    input: WorkerInput<K>,
    options: RunOptions
  ): Promise<Res<K>>;
}

export interface Platform {
  workload: Workload;
  /** Preparing checkouts from a directory; without it, `workspace.prepare` is unsupported. */
  workspace?: WorkspacePort;
}

/** A checkout's Git facts, paths as text (the contract's `gitContext`). */
export type CheckoutGit = {
  repoRoot: string;
  branch: string;
  worktreePath: string;
  worktreeName: string;
  isWorktree: boolean;
  repoIconPath?: string | null;
  origin?: string | null;
};

/** An independent worktree of a directory, as the core resolved it. */
export type WorktreeSpec = {
  /** The directory the worktree is made from, as given. */
  directory: string;
  name: string;
  /** The branch to create, or the base to check out when not creating. */
  branch: string;
  base: string;
  create: boolean;
  /** A directory relative to `directory` to hold it; beside it when absent. */
  nested?: string;
};

/**
 * Preparing a checkout from a directory, as the workload account. The core
 * decides what happens and in which order, records it, and binds the
 * session; the platform does each step on the machine.
 */
export interface WorkspacePort {
  /** The canonical path of an existing directory, else null. */
  canonical(path: string): Promise<string | null>;
  /** Evidence that a directory is the same one later (device, inode, birth), else null. */
  identity(path: string): Promise<string | null>;
  /**
   * Where `create` will put the worktree and which branch it checks out,
   * with the same validation and errors, writing nothing. `taken` when
   * something is already at the path, so `create` will refuse it.
   */
  plan(
    spec: WorktreeSpec
  ): Promise<{ path: string; branch: string; taken: boolean }>;
  /** Make the worktree at the planned path. */
  create(
    spec: WorktreeSpec,
    path: string
  ): Promise<{ path: string; branch: string }>;
  /** Copy the named ignored files from `source` that `destination` lacks; returns those copied. */
  copyIgnored(
    source: string,
    destination: string,
    names: readonly string[]
  ): Promise<string[]>;
  /** Install dependencies, reporting the outcome; a failure is reported, not thrown. */
  installDependencies(
    directory: string,
    report: (step: {
      status: "done" | "failed";
      detail: string;
    }) => Promise<void>
  ): Promise<void>;
  /** The checkout's Git facts: null outside Git, "error" when the probe failed. */
  git(directory: string): Promise<CheckoutGit | null | "error">;
}
