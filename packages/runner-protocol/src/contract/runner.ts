import type { RunnerDescription } from "./description.js";
import type { RunnerError } from "./errors.js";
import type { Placement } from "./opaque.js";
import { operations } from "./operations.js";
import type { Infer } from "./schema.js";

export type Operations = typeof operations;
export type OpName = keyof Operations;
export type CallName = {
  [K in OpName]: Operations[K]["kind"] extends "call" ? K : never;
}[OpName];
export type OpenName = Exclude<OpName, CallName>;

export type Req<K extends OpName> = Infer<Operations[K]["request"]>;
export type Res<K extends OpName> = Infer<Operations[K]["response"]>;
export type Event<K extends OpName> = Operations[K] extends {
  events: infer S;
}
  ? Infer<S>
  : never;

export const operationNames = Object.keys(operations) as OpName[];

export type CallOptions<K extends OpName = OpName> = {
  signal?: AbortSignal;
  /** Events the operation reports while it runs. */
  onEvent?: (event: Event<K>) => void;
};

export type ConnectionState = "connecting" | "ready" | "unavailable" | "closed";

export interface Connection {
  readonly state: ConnectionState;
  /** Increments on every reconnect. */
  readonly epoch: number;
  onChange(listener: (state: ConnectionState) => void): () => void;
}

/** A duplex channel returned by an `open` operation. */
export interface Channel {
  write(data: Uint8Array): void;
  onData(listener: (data: Uint8Array) => void): () => void;
  onClose(listener: (error?: RunnerError) => void): () => void;
  close(): void;
}

export interface Runner {
  /** Last known, also while offline. */
  describe(): RunnerDescription;
  readonly connection: Connection;
  call<K extends CallName>(
    op: K,
    req: Req<K>,
    opts?: CallOptions<K>
  ): Promise<Res<K>>;
  open<K extends OpenName>(
    op: K,
    req: Req<K>,
    opts?: CallOptions<K>
  ): Promise<{ info: Res<K>; channel: Channel }>;
}

export type HandlerContext<K extends OpName> = {
  signal: AbortSignal;
  emit: (event: Event<K>) => void;
};

export type Handler<K extends OpName> = K extends OpenName
  ? (
      req: Req<K>,
      ctx: HandlerContext<K> & { channel: Channel }
    ) => Promise<Res<K>>
  : (req: Req<K>, ctx: HandlerContext<K>) => Promise<Res<K>>;

/** One handler per operation. A missing operation is a type error. */
export type RunnerHandlers = { [K in OpName]: Handler<K> };

export type RunnerSummary = {
  placement: Placement;
  description: RunnerDescription;
};

/** Dispatch's view of every runner. */
export interface Runners {
  for(placement: Placement): Runner;
  list(): RunnerSummary[];
  defaultPlacement(): Placement;
}
