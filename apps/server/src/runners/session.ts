import {
  RunnerCallError,
  sessionFromWire,
  type CallName,
  type CallOptions,
  type OpenName,
  type Req,
  type Res,
  type Runner,
  type RunnerDescription,
} from "@dispatch/runner-protocol/contract";
import {
  operationChannel,
  launchLocalSession,
  openLocalSession,
  readLocalSession,
  requestLocalSession,
  sessionHostStream,
  type LocalSessionRunner,
} from "./local.js";
import {
  RunnerAcknowledgementLost,
  RunnerHostGone,
  RunnerUnavailable,
  RunnerUpdateFenced,
  type RemoteRunnerService,
} from "../agents/remote/service.js";

export type SessionLaunchObservation = Awaited<
  ReturnType<typeof launchLocalSession>
>;
type SessionOptions<K extends CallName> = CallOptions<K> & {
  /** Client bookkeeping; never sent in the runner operation. */
  observeLaunch?: (observation: SessionLaunchObservation) => void;
  /** Preserve this controller's existing host-failure log presentation. */
  hostLog?: boolean;
  /** The native updater's idle stop may wait for a restarting Local child. */
  wait?: boolean;
};
export type SessionRunner = Omit<Runner, "call"> & {
  call<K extends CallName>(
    op: K,
    input: Req<K>,
    options?: SessionOptions<K>
  ): Promise<Res<K>>;
  openStream: LocalSessionRunner["openStream"];
  /** Whether the transport service is configured (not whether its peer is online). */
  readonly enabled: boolean;
  readonly hostFrameLimit?: number;
};
type SessionChild = LocalSessionRunner &
  Partial<Pick<Runner, "describe" | "connection">>;
export type SessionRunners = {
  child?: () => SessionChild | undefined;
  remote?: Pick<RemoteRunnerService, "available" | "call" | "openStream"> &
    Partial<
      Pick<
        RemoteRunnerService,
        | "connectionEpoch"
        | "lastConnectionEpoch"
        | "onConnectionChange"
        | "runnerDescriptions"
      >
    >;
};

export function localSessionRunner(
  resolve: SessionRunners["child"],
  describe: () => RunnerDescription,
  launchWatch: { timeoutMs: number; pollMs: number }
): SessionRunner {
  const child = () => {
    const current = resolve?.();
    if (!current)
      throw new RunnerCallError({
        code: "unavailable",
        message: "The local runner is unavailable",
      });
    return current;
  };
  const runner: SessionRunner = {
    describe: () => resolve?.()?.describe?.() ?? describe(),
    enabled: true,
    connection: {
      get state() {
        return (
          resolve?.()?.connection?.state ??
          (resolve?.() ? "ready" : "unavailable")
        );
      },
      get epoch() {
        return resolve?.()?.connection?.epoch ?? 0;
      },
      onChange(listener) {
        return resolve?.()?.connection?.onChange(listener) ?? (() => {});
      },
    },
    async call<K extends CallName>(
      op: K,
      input: Req<K>,
      options?: SessionOptions<K>
    ): Promise<Res<K>> {
      const current = child();
      if (op === "session.launch") {
        const observation = await launchLocalSession(
          current,
          input as Req<"session.launch">,
          { ...launchWatch, signal: options?.signal }
        );
        options?.observeLaunch?.(observation);
        return {} as Res<K>;
      }
      if (op === "session.stop") {
        if (options?.wait)
          return requestLocalSession(
            current,
            "session.stop",
            input as Req<"session.stop">,
            { signal: options?.signal }
          ) as Promise<Res<K>>;
        try {
          return (await current.call(
            "session.stop",
            input as Req<"session.stop">,
            {
              wait: false,
              timeoutMs: 30_000,
              ...(options?.signal && { signal: options.signal }),
            }
          )) as Res<K>;
        } catch (error) {
          if (error instanceof RunnerCallError && error.code === "timeout")
            throw new RunnerAcknowledgementLost(error.message);
          throw error;
        }
      }
      if (op === "session.discard")
        return requestLocalSession(
          current,
          "session.discard",
          input as Req<"session.discard">,
          { signal: options?.signal }
        ) as Promise<Res<K>>;
      if (op === "session.logs" && options?.hostLog) {
        const text = await readLocalSession(
          current,
          "session.logs",
          input as Req<"session.logs">,
          { signal: options?.signal }
        )
          .then(({ text }) => text.trim())
          .catch(() => "");
        const lines = (input as Req<"session.logs">).lines;
        return {
          text: text ? `\n\nHost log (last ${lines} lines):\n${text}` : "",
        } as Res<K>;
      }
      if (
        op === "session.alive" ||
        op === "session.logs" ||
        op === "session.list" ||
        op === "session.sample"
      )
        return readLocalSession(current, op, input as never, {
          signal: options?.signal,
        }) as Promise<Res<K>>;
      return current.call(op, input, options);
    },
    openStream: (op, input, options) =>
      op === "session.attach"
        ? openLocalSession(child(), op, input, options)
        : child().openStream(op, input, options),
    async open(op, input, options) {
      const { info, channel } = await runner.openStream(op, input, options);
      return { info, channel: operationChannel(op, channel) };
    },
  };
  return runner;
}

/** Translate enrolled carrier refusals at its transport boundary. */
function enrolledFailure(error: unknown): never {
  if (!(error instanceof RunnerCallError)) throw error;
  if (error.code === "host_gone") throw new RunnerHostGone(error.message);
  if (error.code === "unavailable") throw new RunnerUnavailable(error.message);
  if (error.code === "unknown_outcome")
    throw new RunnerAcknowledgementLost(error.message);
  if (error.code === "fenced") throw new RunnerUpdateFenced(error.message);
  throw error;
}

export function enrolledSessionRunner(
  service: SessionRunners["remote"],
  runnerId: string,
  describe: () => RunnerDescription
): SessionRunner {
  const remote = () => {
    if (!service) throw new RunnerUnavailable("Remote runner is disabled.");
    return service;
  };
  const runner: SessionRunner = {
    describe,
    enabled: Boolean(service),
    hostFrameLimit: 32 * 1024 * 1024,
    connection: {
      get state() {
        return service?.available(runnerId) ? "ready" : "unavailable";
      },
      get epoch() {
        return service?.lastConnectionEpoch?.(runnerId) ?? 0;
      },
      onChange(listener) {
        return (
          service?.onConnectionChange?.((id) => {
            if (id === runnerId) listener(this.state);
          }) ?? (() => {})
        );
      },
    },
    async call(op, input, options) {
      try {
        const wireOptions =
          options?.signal || options?.onEvent
            ? { signal: options.signal, onEvent: options.onEvent }
            : undefined;
        return wireOptions
          ? await remote().call(runnerId, op, input, wireOptions)
          : await remote().call(runnerId, op, input);
      } catch (error) {
        return enrolledFailure(error);
      }
    },
    async openStream(op, input, options) {
      try {
        return options?.signal
          ? await remote().openStream(runnerId, op, input, options.signal)
          : await remote().openStream(runnerId, op, input);
      } catch (error) {
        return enrolledFailure(error);
      }
    },
    async open(op, input, options) {
      const { info, channel } = await runner.openStream(op, input, options);
      return { info, channel: operationChannel(op, channel) };
    },
  };
  return runner;
}

/** Only framing compatibility remains here; runner selection is already complete. */
export async function sessionHostChannel(
  runner: SessionRunner,
  agentId: string
) {
  const { channel } = await runner.openStream("session.attach", {
    session: sessionFromWire(agentId),
  });
  return sessionHostStream(channel, agentId, runner.hostFrameLimit);
}
