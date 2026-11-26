import {
  operations,
  RunnerCallError,
  type OpName,
  type Req,
} from "@dispatch/runner-protocol/contract";
import type { LocalSocketConnection } from "@dispatch/runner-client/transport/local-socket";

type Peer = {
  epoch: number;
  approved(): boolean;
  connection: LocalSocketConnection;
};

function sessionIds(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const ids = new Set<string>();
  const add = (target: unknown) => {
    if (
      target &&
      typeof target === "object" &&
      "session" in target &&
      typeof target.session === "string"
    )
      ids.add(target.session);
  };
  add(input);
  if ("target" in input) add(input.target);
  if ("source" in input) add(input.source);
  if ("sessions" in input && Array.isArray(input.sessions)) {
    for (const session of input.sessions)
      if (typeof session === "string") ids.add(session);
  }
  return [...ids];
}

/**
 * Pin the authenticated connection before looking up placements. Only the
 * current registration can write, including after a reconnect during lookup.
 * The caller writes synchronously inside send, with no asynchronous gap.
 */
export async function withSessionPeer<K extends OpName, T>(
  runnerId: string,
  op: K,
  input: Req<K>,
  current: () => Peer | undefined,
  ownsSessions: (runnerId: string, sessions: string[]) => Promise<boolean>,
  send: (connection: LocalSocketConnection) => T,
  expectedEpoch?: number
): Promise<Awaited<T>> {
  const peer = current();
  const unavailable = () =>
    new RunnerCallError({
      code: "unavailable",
      message: "The session runner is unavailable.",
    });
  if (
    !peer ||
    !peer.approved() ||
    !peer.connection.connected ||
    (expectedEpoch !== undefined && expectedEpoch !== peer.epoch)
  )
    throw unavailable();
  if (!operations[op].request.check(input))
    throw new RunnerCallError({
      code: "invalid",
      message: `Invalid ${op} request`,
    });
  const sessions = sessionIds(input);
  if (sessions.length && !(await ownsSessions(runnerId, sessions)))
    throw new RunnerCallError({
      code: "not_found",
      message: "The session is unavailable on this runner.",
    });
  if (peer !== current() || !peer.approved() || !peer.connection.connected)
    throw unavailable();
  return await send(peer.connection);
}
