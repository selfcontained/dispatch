/*
 * The platform port: what the runner core asks of the machine it runs on.
 * One core, two platforms (`posix-user`, `linux-privsep`). Only `workload`
 * exists so far; process, layout and private-state parts arrive with the
 * families that need them.
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
}
