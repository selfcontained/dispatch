import type { FastifyBaseLogger } from "fastify";
import type { AgentEventListener, AgentRecord } from "./types.js";

export type AgentEventBus = {
  /** Register a callback invoked when an agent record changes. */
  subscribe(listener: AgentEventListener): void;

  /**
   * Fan out an updated `AgentRecord` to every subscribed listener. Each
   * listener is isolated — a thrown listener cannot stop subsequent
   * listeners or surface an error to the publisher. The isolation covers
   * both synchronous throws and asynchronous rejections (the latter is
   * possible because `AgentEventListener`'s `=> void` return type is
   * structurally compatible with `=> Promise<void>`).
   *
   * `publish()` itself returns synchronously after each listener has been
   * scheduled — async listeners run to completion in the background.
   */
  publish(agent: AgentRecord): void;
};

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then: unknown }).then === "function"
  );
}

/**
 * In-memory pub/sub for agent record updates. Listeners are invoked
 * in registration order. The bus deliberately swallows listener errors
 * (sync throws *and* async rejections) so a buggy SSE writer cannot poison
 * the data layer that published the record.
 */
export function createAgentEventBus(logger: FastifyBaseLogger): AgentEventBus {
  const listeners: AgentEventListener[] = [];

  return {
    subscribe(listener: AgentEventListener): void {
      listeners.push(listener);
    },

    publish(agent: AgentRecord): void {
      for (const listener of listeners) {
        // Sync listeners run on the publishing thread (preserves the
        // immediate-fanout contract). The try/catch handles their throws.
        // If a listener returns a Promise (the `=> void` listener type
        // structurally accepts `async` listeners), attach a .catch to the
        // returned thenable so async rejections also get logged instead
        // of escaping as an unhandled rejection.
        try {
          const result = listener(agent) as unknown;
          if (isThenable(result)) {
            // PromiseLike only guarantees `.then`, not `.catch`. The
            // two-arg `.then(undefined, handler)` form is the portable
            // way to attach a rejection handler.
            result.then(undefined, (err: unknown) => {
              logger.warn({ err }, "Agent event listener threw");
            });
          }
        } catch (err) {
          logger.warn({ err }, "Agent event listener threw");
        }
      }
    },
  };
}
