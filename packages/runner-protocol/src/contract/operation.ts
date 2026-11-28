import type { DeclarableError } from "./errors.js";
import type { Schema } from "./schema.js";

/** How a repeat of the same request behaves. */
export type Retry =
  /** Safe to repeat. */
  | { kind: "read" }
  /** A repeat with the same key returns the first result; a different request under it is `conflict`. */
  | { kind: "key"; key: readonly string[] }
  /** Safe to repeat; rejected with `stale` if the named field no longer matches. */
  | { kind: "state"; field: string }
  /** Never repeated automatically. */
  | { kind: "none" };

/** Reply deadline class. The client maps classes to durations. */
export type Timeout = "default" | "long" | "request";

/** `call` returns one response, optionally with events while it runs. `open` also returns a channel. */
export type Kind = "call" | "open";

export type ChannelSpec = {
  /** What the caller writes. `bytes` is an untyped byte stream. */
  toRunner: Schema<unknown> | "bytes";
  /** What the runner writes. */
  fromRunner: Schema<unknown> | "bytes";
};

export interface OperationSpec<Req = unknown, Res = unknown> {
  scope: "runner" | "session";
  kind: Kind;
  request: Schema<Req>;
  response: Schema<Res>;
  errors: readonly DeclarableError[];
  retry: Retry;
  timeout: Timeout;
  capability: "baseline" | "selfUpdate";
  /** Events a `call` reports while it runs (progress, samples). */
  events?: Schema<unknown>;
  /** The channel an `open` returns. */
  channel?: ChannelSpec;
  /** Cancellation is part of the operation's contract. */
  cancellable?: true;
}

/** Keeps each entry's literal kind, schemas and optional parts in its type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function op<const S extends OperationSpec<any, any>>(spec: S): S {
  return spec;
}
