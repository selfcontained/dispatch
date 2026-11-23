import { randomUUID } from "node:crypto";
import { Duplex, PassThrough } from "node:stream";
import {
  isTerminalEvent,
  isTerminalInfo,
  MAX_TERMINAL_FRAME_LENGTH,
  type Command,
  type TerminalControl,
  type TerminalEvent,
} from "@dispatch/runner-protocol";
import {
  RunnerCallError,
  type CallerChannel,
  type Req,
  type RunnerError,
} from "@dispatch/runner-protocol/contract";
import { wireFrames, type FlowStreams } from "./node.js";

type OpenTerminal = Extract<Command, { kind: "openTerminal" }>;

/** Open the two credit streams of the typed terminal operation on wire v1. */
export async function openTerminalStream(
  command: OpenTerminal,
  { cols, rows }: Pick<Req<"terminal.open">, "cols" | "rows">,
  request: (
    command: OpenTerminal,
    signal: AbortSignal
  ) => Promise<{ value?: string | boolean }>,
  streams: FlowStreams,
  signal?: AbortSignal
) {
  const stream = { input: randomUUID(), output: randomUUID(), cols, rows };
  const controller = new AbortController();
  const active = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  active.throwIfAborted();

  const output = new PassThrough();
  const input = new PassThrough();
  const io = Duplex.from({ readable: output, writable: input });
  io.on("error", () => {});
  const data = new Set<(event: TerminalEvent) => void>();
  const closed = new Set<(error?: RunnerError) => void>();

  const receiving = streams.receive(stream.output, output, active, {
    stall: false,
  });
  void receiving.catch(() => {});
  try {
    const { value } = await request({ ...command, stream }, active);
    const info: unknown = typeof value === "string" ? JSON.parse(value) : null;
    if (!isTerminalInfo(info))
      throw new RunnerCallError({
        code: "invalid",
        message: "Invalid terminal response",
      });
    io.pause();
    const send = wireFrames<unknown, TerminalControl>(
      io,
      (event) => {
        if (!isTerminalEvent(event)) return controller.abort();
        for (const listener of data) listener(event);
      },
      MAX_TERMINAL_FRAME_LENGTH
    );
    io.once("close", () => {
      // A peer cancellation destroys the sink before its error is delivered.
      // Read that result before handing the close reason to callers.
      if (!output.destroyed) controller.abort();
    });
    let ended: { error?: RunnerError } | undefined;
    const finish = (error?: RunnerError) => {
      if (ended) return;
      ended = { error };
      for (const listener of closed) listener(error);
      controller.abort();
    };
    io.once("end", () => finish());
    void receiving.catch((error: RunnerCallError) =>
      finish({
        code: error.code,
        message: error.message,
        details: error.details,
      })
    );
    void streams
      .send(stream.input, input, active, { stall: "blocked" })
      .catch(() => {
        // The output transfer owns the close reason. End the input half so
        // a failed input stream also closes the worker's stdio lifeline.
        input.destroy();
      });

    const channel: CallerChannel<"terminal.open"> = {
      write: send,
      onData(listener) {
        data.add(listener);
        io.resume();
        return () => data.delete(listener);
      },
      onClose(listener) {
        closed.add(listener);
        if (ended) {
          const { error } = ended;
          queueMicrotask(() => {
            if (closed.has(listener)) listener(error);
          });
        }
        return () => closed.delete(listener);
      },
      close: () => controller.abort(),
    };
    return { info, channel };
  } catch (error) {
    controller.abort();
    io.destroy();
    throw error;
  }
}
