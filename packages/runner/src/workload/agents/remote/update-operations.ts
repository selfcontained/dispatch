import { AsyncLocalStorage } from "node:async_hooks";
import {
  endsUpdateAttempt,
  parseUpdateServiceFrame,
  parseUpdateStatus,
  type UpdateStatusFrame,
} from "@dispatch/runner-protocol";
import { RunnerCallError, type Res } from "@dispatch/runner-protocol/contract";
import type { CallHandlers } from "../../../handlers.js";
import type { createRunnerUpdateAgent } from "./update-agent.js";

type Agent = ReturnType<typeof createRunnerUpdateAgent>;
type Status = Res<"update.offer">;

/** The updater owns attempt state. Closing the connection only ends its requests. */
export function enrolledUpdates(
  agent: Agent,
  observe: (frame: UpdateStatusFrame) => void
) {
  type Pending = ReturnType<typeof Promise.withResolvers<Status>>;
  const origin = new AsyncLocalStorage<Pending>();
  const active = new Map<string, Set<Pending>>();
  let closed = false;
  const unavailable = () =>
    new RunnerCallError({
      code: "unavailable",
      message: "The runner update connection is closed.",
    });
  const connection = agent.connect((frame) => {
    if (closed) return;
    // The coordinator observes each transition once, including transitions
    // for an attempt on a previous connection. RPC responses are for callers.
    observe(frame);
    const parsed = parseUpdateStatus(frame);
    if (!parsed) throw new Error("Invalid protected update status.");
    const { type: _, ...status } = parsed;
    const waiting = active.get(frame.attemptId);
    if (!waiting) return;
    const sender = origin.getStore();
    if (sender && waiting.has(sender)) sender.resolve(status);
    // The durable helper reports its terminal outcome independently of the
    // call that signalled it. That outcome also settles a concurrent waiter.
    if (!sender || endsUpdateAttempt(frame))
      for (const caller of waiting) caller.resolve(status);
  });

  async function perform(input: unknown): Promise<Status> {
    if (closed) throw unavailable();
    if (!agent.advert())
      throw new RunnerCallError({
        code: "unsupported",
        message: "This runner does not support supervisor updates.",
      });
    const frame = parseUpdateServiceFrame(input);
    if (!frame)
      throw new RunnerCallError({
        code: "invalid",
        message: "Invalid runner update frame.",
      });
    const caller = Promise.withResolvers<Status>();
    let waiting = active.get(frame.attemptId);
    if (!waiting) active.set(frame.attemptId, (waiting = new Set()));
    waiting.add(caller);
    try {
      // A durable confirm/reject is acknowledged by trial reconciliation,
      // which can arrive after receive() returns.
      const [status] = await Promise.all([
        caller.promise,
        origin.run(caller, () => connection.receive(frame)),
      ]);
      return status;
    } finally {
      waiting.delete(caller);
      if (!waiting.size && active.get(frame.attemptId) === waiting)
        active.delete(frame.attemptId);
    }
  }

  return {
    calls: {
      "update.offer": ({ attempt, target, retry }) =>
        perform({ type: "update_offer", attemptId: attempt, target, retry }),
      "update.fence": ({ attempt, retained }) =>
        perform({
          type: "update_fence",
          attemptId: attempt,
          retainSessions: retained,
        }),
      "update.activate": ({ attempt }) =>
        perform({ type: "update_activate", attemptId: attempt }),
      "update.confirm": ({ attempt, revision, sha256 }) =>
        perform({
          type: "update_confirm",
          attemptId: attempt,
          revision,
          sha256,
        }),
      "update.cancel": ({ attempt, reason }) =>
        perform({ type: "update_cancel", attemptId: attempt, reason }),
    } satisfies CallHandlers,
    close() {
      if (closed) return;
      closed = true;
      connection.close();
      for (const waiting of active.values())
        for (const caller of waiting) caller.reject(unavailable());
      active.clear();
    },
  };
}
