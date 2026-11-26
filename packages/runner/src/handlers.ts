import type { Writable, Readable, Duplex } from "node:stream";
import type {
  CallName,
  OpenName,
  Req,
  Res,
} from "@dispatch/runner-protocol/contract";

/** What a handler may use of the connection its request arrived on. */
export type ConnectionContext = {
  /** An enrolled caller cancelled its command, or its authenticated connection closed. */
  signal?: AbortSignal;
  /** Forward a checkout process stream on the enrolled command's connection. */
  sendOutput?(
    name: "stdout" | "stderr",
    source: Readable,
    signal: AbortSignal
  ): Promise<void>;
  /** Stream the contents of this enrolled files.get response under its call-scoped blob ID. */
  sendFile?(source: Readable): Promise<string>;
  /**
   * Expect a blob under `id` and write it into `sink`. The caller sends it as
   * bytes or, on this socket, as a file path. Register before the handler's
   * first `await`: frames after the request may already carry it.
   */
  receiveBlob(id: string, sink: Writable): Promise<void>;
  /**
   * Expect a blob under `id` as the path of a file on this machine, taken
   * where it is: nothing is read. Only this socket's path frame marked
   * `inPlace` satisfies it, and a plain blob refuses such a frame. Register
   * before the handler's first `await`. Absent where a transport cannot
   * hand a path over in place.
   */
  receiveBlobPath?(id: string): Promise<InPlaceBlob>;
  /**
   * Report one event of this call (an operation's declared `events`) before
   * its answer. An event the operation does not declare is dropped.
   */
  emit(event: unknown): void;
};

export type CallHandlers = Partial<{
  [K in CallName]: (
    input: Req<K>,
    context: ConnectionContext
  ) => Promise<Res<K>> | Res<K>;
}>;

/** An `open` handler returns its info and the runner's end of the channel. */
export type OpenHandlers = Partial<{
  [K in OpenName]: (
    input: Req<K>,
    context: ConnectionContext
  ) => Promise<{ info: Res<K>; channel: Duplex }>;
}>;

export type Handlers = { calls: CallHandlers; opens?: OpenHandlers };

/** A file handed over where it is (`receiveBlobPath`). */
export type InPlaceBlob = { path: string; mustExist: boolean };
