/*
 * The platform port: what the runner core asks of the machine it runs on.
 * One core, two platforms (`posix-user`, `linux-privsep`). Only `workload`
 * exists so far; process, layout and private-state parts arrive with the
 * families that need them.
 */
import type { Req, Res } from "@dispatch/runner-protocol/contract";

/**
 * Operations a platform runs as the workload account. On `posix-user` that
 * is a direct function call in the runner's own process; on
 * `linux-privsep` it is one self-exec of the worker entry under the
 * workload's identity.
 */
export const WORKER_OPS = [
  "checkout.list",
  "checkout.preview",
  "checkout.index",
  "checkout.read",
  "checkout.stats",
  "checkout.diff",
  "checkout.changes",
] as const;

export type WorkerOp = (typeof WORKER_OPS)[number];

/**
 * A worker operation's input: the request without its target, and the
 * directory the core resolved the target to. The workload never sees a
 * session handle, and the core never touches the directory itself.
 */
export type WorkerInput<K extends WorkerOp> = {
  directory: string;
  request: Omit<Req<K>, "target">;
};

export type RunOptions = { signal?: AbortSignal };

export interface Workload {
  run<K extends WorkerOp>(
    op: K,
    input: WorkerInput<K>,
    options: RunOptions
  ): Promise<Res<K>>;
}

export interface Platform {
  workload: Workload;
}
