import type { Duplex } from "node:stream";
import {
  RunnerCallError,
  sessionFromWire,
  type Req,
  type Res,
  type OpenName,
} from "@dispatch/runner-protocol/contract";
import type { LocalRunnerSession, SessionCallOptions } from "./local-runner.js";
import {
  encodeHostFrame,
  mapIncomingFrames,
  type HostMessage,
} from "../v1/host.js";

/** What the agent runtime uses of the child for local hosts. */
export type LocalSessionRunner = Pick<
  LocalRunnerSession,
  "call" | "openStream"
>;

/**
 * A local host's channel through the child, as the host client reads it:
 * the host's own v1 frames with the agent id the contract channel drops.
 * Waits while the child restarts.
 */
export async function localHostChannel(
  child: LocalSessionRunner,
  agentId: string
): Promise<Duplex> {
  const { channel } = await openLocalSession(child, "session.attach", {
    session: sessionFromWire(agentId),
  });
  return sessionHostStream(channel, agentId);
}

/** A bounded channel open through a restarting Local runner. */
export function openLocalSession<K extends OpenName>(
  child: LocalSessionRunner,
  op: K,
  input: Req<K>,
  options: SessionCallOptions<K> = {}
) {
  return unavailableAfter(ATTACH_WAIT_MS, (signal) =>
    child.openStream(op, input, {
      ...options,
      wait: true,
      signal: joinedSignal(signal, options.signal),
    })
  );
}

/** Adapt the contract's session channel for a v1 HostClient, on either transport. */
export function sessionHostStream(
  channel: Duplex,
  agentId: string,
  maxFrameBytes?: number
): Duplex {
  return mapIncomingFrames(
    channel,
    (message) => encodeHostFrame(message as HostMessage, agentId),
    maxFrameBytes
  );
}

/** How long one attach waits for a restarting child; the caller retries. */
const ATTACH_WAIT_MS = 5_000;
/** How long a host read waits for a restarting child. */
const SESSION_READ_WAIT_MS = 15_000;

/**
 * A session read through the child, waiting a bounded time while it
 * restarts: start-up and reconcile passes read hosts and must not hang on
 * a child that cannot start. Not answering in time is `unavailable`.
 */
export function readLocalSession<
  K extends
    | "session.alive"
    | "session.logs"
    | "session.list"
    | "session.sample",
>(
  child: LocalSessionRunner,
  op: K,
  input: Req<K>,
  options: SessionCallOptions<K> = {}
): Promise<Res<K>> {
  return unavailableAfter(SESSION_READ_WAIT_MS, (signal) =>
    child.call(op, input, {
      ...options,
      signal: joinedSignal(signal, options.signal),
    })
  );
}

/**
 * How long a launch, stop or discard waits, in all, for a child that is
 * down or restarting before it fails with `unavailable`. A launch includes
 * its host's start; a stop its grace periods.
 */
const SESSION_WRITE_WAIT_MS = {
  "session.launch": 90_000,
  "session.stop": 30_000,
  "session.discard": 30_000,
} as const;

/**
 * A launch, stop or discard through the child. A call lost with the child
 * is sent again to its replacement (a launch by its ID, which the child
 * answers for the host it already started); a child that does not come
 * back in time is `unavailable`, an ordinary error.
 */
export function requestLocalSession<
  K extends keyof typeof SESSION_WRITE_WAIT_MS,
>(
  child: LocalSessionRunner,
  op: K,
  input: Req<K>,
  options: SessionCallOptions<K> = {}
): Promise<Res<K>> {
  return unavailableAfter(SESSION_WRITE_WAIT_MS[op], (signal) =>
    child.call(op, input, {
      ...options,
      signal: joinedSignal(signal, options.signal),
      timeoutMs: null,
    })
  );
}

const joinedSignal = (deadline: AbortSignal, caller?: AbortSignal) =>
  caller ? AbortSignal.any([deadline, caller]) : deadline;

async function unavailableAfter<T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const signal = AbortSignal.timeout(ms);
  try {
    return await run(signal);
  } catch (error) {
    if (
      signal.aborted &&
      error instanceof RunnerCallError &&
      error.code === "cancelled"
    )
      throw new RunnerCallError({
        code: "unavailable",
        message: "The local runner is unavailable",
      });
    throw error;
  }
}

/** Observe an early host exit until the caller finishes its launch handshake. */
export async function launchLocalSession(
  child: LocalSessionRunner,
  request: Req<"session.launch">,
  options: { timeoutMs: number; pollMs: number; signal?: AbortSignal }
) {
  await requestLocalSession(child, "session.launch", request, {
    signal: options.signal,
  });
  let exited = false;
  let watching = true;
  const deadline = Date.now() + options.timeoutMs;
  void (async () => {
    while (watching && !exited && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, options.pollMs));
      if (!watching) return;
      try {
        const { state } = await child.call(
          "session.alive",
          { session: request.session },
          { wait: false }
        );
        if (state === "gone") exited = true;
      } catch {
        // Unavailable is not gone.
      }
    }
  })();
  return {
    launchExited: () => exited,
    launchSettled: () => {
      watching = false;
    },
  };
}
