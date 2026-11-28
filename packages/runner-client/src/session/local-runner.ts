/*
 * The caller's side of a local runner: one connection at a time to the
 * endpoint its supervisor reports, and the reconnect rules.
 *
 * - Unavailable is not dead. While the runner is down (restarting, not yet
 *   started) calls wait for it and are sent once it is back. Nothing here
 *   gives up on a timer; a caller that cannot wait passes `wait: false` and
 *   gets `unavailable`, or aborts its signal.
 * - A call that was never sent is always sent again (`unavailable` means not
 *   sent). A call lost after it was written (`unknown_outcome`) is sent again
 *   only when its operation's retry rule says a repeat is safe (`read`,
 *   `key`, `state`); a `none` operation surfaces `unknown_outcome`.
 * - The endpoint is never probed: the session dials only when it has calls
 *   to make or channels to open, or to come back after a loss, and holds at
 *   most one connection.
 */
import type { Duplex } from "node:stream";
import {
  operations,
  RunnerCallError,
  type CallName,
  type CallOptions,
  type CallerChannel,
  type Connection,
  type ConnectionState,
  type OpenName,
  type OperationSpec,
  type Req,
  type Res,
  type Runner,
  type RunnerDescription,
  type RunnerError,
  type Schema,
} from "@dispatch/runner-protocol/contract";
import {
  jsonLines,
  LocalSocketConnection,
  type LocalEndpoint,
} from "../transport/local-socket.js";

export type SessionCallOptions<K extends CallName | OpenName> =
  CallOptions<K> & {
    /**
     * Wait while the runner is unavailable (calls default to true, opens to
     * false). With false, an unavailable runner rejects with `unavailable`.
     */
    wait?: boolean;
    /**
     * The reply deadline of each attempt; null waits without one. Default:
     * the operation's deadline class.
     */
    timeoutMs?: number | null;
  };

export type LocalRunnerSessionOptions = {
  /** Last known description, served until the runner first answers. */
  description: RunnerDescription;
  /** Backoff between dials while an endpoint is known but refuses. */
  retry?: { initialMs: number; maxMs: number };
  connectTimeoutMs?: number;
};

const unavailable = (message = "The local runner is unavailable") =>
  new RunnerCallError({ code: "unavailable", message });

const sameEndpoint = (a: LocalEndpoint | null, b: LocalEndpoint | null) =>
  a === b || (!!a && !!b && a.socket === b.socket && a.nonce === b.nonce);

export class LocalRunnerSession implements Runner {
  private endpoint: LocalEndpoint | null = null;
  private current: LocalSocketConnection | null = null;
  private dialing = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private waiters = new Set<{
    resolve(connection: LocalSocketConnection): void;
    reject(error: RunnerCallError): void;
  }>();
  private state: ConnectionState = "connecting";
  private epoch = 0;
  private readonly listeners = new Set<(state: ConnectionState) => void>();
  private description: RunnerDescription;

  constructor(private readonly options: LocalRunnerSessionOptions) {
    this.description = options.description;
  }

  readonly connection: Connection = ((session) => ({
    get state() {
      return session.state;
    },
    get epoch() {
      return session.epoch;
    },
    onChange: (listener: (state: ConnectionState) => void) => {
      session.listeners.add(listener);
      return () => session.listeners.delete(listener);
    },
  }))(this);

  describe(): RunnerDescription {
    return this.description;
  }

  /**
   * The supervisor's current endpoint, or null while the runner is down. A
   * new endpoint replaces the connection to the old one.
   */
  setEndpoint(endpoint: LocalEndpoint | null): void {
    if (this.closed || sameEndpoint(this.endpoint, endpoint)) return;
    this.endpoint = endpoint;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.failures = 0;
    const previous = this.current;
    this.current = null;
    previous?.close();
    if (!endpoint) return this.setState("unavailable");
    if (this.waiters.size) this.dial();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.current?.close();
    this.current = null;
    for (const waiter of this.waiters)
      waiter.reject(unavailable("The local runner session is closed"));
    this.waiters.clear();
    this.setState("closed");
  }

  private setState(state: ConnectionState) {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  private dial() {
    if (this.dialing || this.current || this.closed || !this.endpoint) return;
    const endpoint = this.endpoint;
    this.dialing = true;
    if (this.state !== "unavailable") this.setState("connecting");
    LocalSocketConnection.connect(endpoint, this.options.connectTimeoutMs).then(
      (connection) => {
        this.dialing = false;
        if (this.closed || this.endpoint !== endpoint) {
          connection.close();
          return this.dial();
        }
        this.failures = 0;
        this.current = connection;
        this.epoch += 1;
        connection.onClose(() => this.lost(connection));
        this.setState("ready");
        for (const waiter of this.waiters) waiter.resolve(connection);
        this.waiters.clear();
        void connection
          .call("runner.describe", {})
          .then((description) => {
            this.description = description;
          })
          .catch(() => {});
      },
      () => {
        this.dialing = false;
        if (this.closed) return;
        this.setState("unavailable");
        this.retryLater();
      }
    );
  }

  private lost(connection: LocalSocketConnection) {
    if (this.current !== connection) return;
    this.current = null;
    if (this.closed) return;
    this.setState("unavailable");
    // Come back for whoever is waiting; an idle session dials on demand.
    if (this.waiters.size) this.retryLater();
  }

  private retryLater() {
    if (this.timer || !this.endpoint) return;
    const { initialMs, maxMs } = this.options.retry ?? {
      initialMs: 100,
      maxMs: 2_000,
    };
    const delay = Math.min(maxMs, initialMs * 2 ** Math.min(this.failures, 10));
    this.failures += 1;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.dial();
    }, delay);
    this.timer.unref?.();
  }

  /** The live connection, waiting for one when asked to. */
  private async connected(
    wait: boolean,
    signal?: AbortSignal
  ): Promise<LocalSocketConnection> {
    if (this.closed) throw unavailable("The local runner session is closed");
    if (this.current?.connected) return this.current;
    if (!wait) {
      this.dial();
      throw unavailable();
    }
    if (signal?.aborted)
      throw new RunnerCallError({ code: "cancelled", message: "Cancelled" });
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.waiters.delete(waiter);
        reject(
          new RunnerCallError({ code: "cancelled", message: "Cancelled" })
        );
      };
      const waiter = {
        resolve: (connection: LocalSocketConnection) => {
          signal?.removeEventListener("abort", abort);
          resolve(connection);
        },
        reject: (error: RunnerCallError) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      };
      this.waiters.add(waiter);
      signal?.addEventListener("abort", abort, { once: true });
      this.dial();
      // A lost connection with no timer pending (it was idle) needs a dial.
      if (!this.dialing && !this.current) this.retryLater();
    });
  }

  async call<K extends CallName>(
    op: K,
    req: Req<K>,
    opts: SessionCallOptions<K> = {}
  ): Promise<Res<K>> {
    const spec = operations[op] as OperationSpec;
    const repeatable = spec.retry.kind !== "none";
    for (;;) {
      const connection = await this.connected(opts.wait !== false, opts.signal);
      try {
        return await connection.call(op, req, {
          signal: opts.signal,
          timeoutMs: opts.timeoutMs,
          onEvent: opts.onEvent as ((event: unknown) => void) | undefined,
        });
      } catch (error) {
        if (!(error instanceof RunnerCallError)) throw error;
        const again =
          error.code === "unavailable" ||
          (error.code === "unknown_outcome" && repeatable);
        if (!again || opts.wait === false || opts.signal?.aborted) throw error;
      }
    }
  }

  /** Open a channel as bytes: the transport's duplex. */
  async openStream<K extends OpenName>(
    op: K,
    req: Req<K>,
    opts: SessionCallOptions<K> = {}
  ): Promise<{ info: Res<K>; channel: Duplex }> {
    const connection = await this.connected(opts.wait === true, opts.signal);
    return connection.openChannel(op, req, { signal: opts.signal });
  }

  async open<K extends OpenName>(
    op: K,
    req: Req<K>,
    opts: SessionCallOptions<K> = {}
  ): Promise<{ info: Res<K>; channel: CallerChannel<K> }> {
    const { info, channel } = await this.openStream(op, req, opts);
    return { info, channel: operationChannel(op, channel) };
  }

  /** Uncapped Local download, read once on the live connection. */
  async getFile(
    input: Req<"files.get">,
    signal?: AbortSignal
  ): Promise<Buffer> {
    const connection = await this.connected(false, signal);
    return connection.collectFile(input, { maxBytes: null, signal });
  }

  /** Hand the runner a blob it expects; on this transport a path may be sent. */
  async sendBlob(
    id: string,
    source: Parameters<LocalSocketConnection["sendBlob"]>[1],
    signal?: AbortSignal
  ): Promise<void> {
    const connection = await this.connected(false, signal);
    return connection.sendBlob(id, source, signal);
  }
}

export function operationChannel<K extends OpenName>(
  op: K,
  channel: Duplex
): CallerChannel<K> {
  const spec = (operations[op] as OperationSpec).channel;
  return typedChannel(
    channel,
    spec?.fromRunner === "bytes" ? null : (spec?.fromRunner ?? null),
    spec?.toRunner === "bytes" ? null : (spec?.toRunner ?? null)
  ) as unknown as CallerChannel<K>;
}

/** A channel over a duplex: JSON lines when typed, bytes otherwise. */
function typedChannel(
  duplex: Duplex,
  incoming: Schema<unknown> | null,
  outgoing: Schema<unknown> | null
) {
  const dataListeners = new Set<(data: unknown) => void>();
  const closeListeners = new Set<(error?: RunnerError) => void>();
  let failure: RunnerError | undefined;
  const fail = (error: RunnerError) => {
    failure ??= error;
    duplex.destroy();
  };
  if (incoming)
    jsonLines(duplex, (message) => {
      if (!incoming.check(message))
        return fail({ code: "invalid", message: "Invalid channel message" });
      for (const listener of dataListeners) listener(message);
    });
  else
    duplex.on("data", (chunk: Buffer) => {
      for (const listener of dataListeners) listener(new Uint8Array(chunk));
    });
  duplex.on("error", () => {});
  duplex.once("close", () => {
    for (const listener of closeListeners) listener(failure);
  });
  return {
    write(data: unknown) {
      if (outgoing && !outgoing.check(data))
        throw new RunnerCallError({
          code: "invalid",
          message: "Invalid channel message",
        });
      duplex.write(
        outgoing ? JSON.stringify(data) + "\n" : (data as Uint8Array)
      );
    },
    onData(listener: (data: unknown) => void) {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },
    onClose(listener: (error?: RunnerError) => void) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close() {
      duplex.destroy();
    },
  };
}
