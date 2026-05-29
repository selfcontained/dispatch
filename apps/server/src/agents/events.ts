import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import { AgentError } from "./errors.js";
import type {
  AgentEventListener,
  AgentLatestEventInput,
  AgentRecord,
} from "./types.js";

/**
 * Persist a latest-event update for `id`. Two writes:
 *   1. UPDATE the agent's `latest_event_*` columns synchronously. Throws
 *      `AgentError(404)` if the agent has no live row.
 *   2. INSERT into `agent_events` history fire-and-forget — failures are
 *      logged but never propagated, since losing one history row should
 *      not block the live status indicator update.
 *
 * Validates that `message` trims to non-empty; throws `AgentError(400)`
 * otherwise. Returns void — callers that need the resulting AgentRecord
 * read it back themselves (the manager façade fetches + publishes to the
 * listener bus before returning to the caller).
 */
export async function writeLatestEvent(
  pool: Pool,
  logger: FastifyBaseLogger,
  id: string,
  input: AgentLatestEventInput
): Promise<void> {
  const message = input.message.trim();
  if (!message) {
    throw new AgentError(
      "Latest event message must be a non-empty string.",
      400
    );
  }

  const result = await pool.query(
    `
    UPDATE agents
    SET latest_event_type = $2,
        latest_event_message = $3,
        latest_event_metadata = $4::jsonb,
        latest_event_updated_at = NOW(),
        updated_at = NOW()
    WHERE id = $1 AND deleted_at IS NULL
    `,
    [id, input.type, message, JSON.stringify(input.metadata ?? {})]
  );

  if (result.rowCount !== 1) {
    throw new AgentError("Agent not found.", 404);
  }

  // Append to event history (fire-and-forget — keeping this off the critical
  // path means the agent status indicator updates even if the history table
  // is briefly unavailable).
  pool
    .query(
      `INSERT INTO agent_events (agent_id, event_type, message, metadata, agent_type, agent_name, project_dir)
       SELECT $1, $2, $3, $4::jsonb, type, name, COALESCE(git_context->>'repoRoot', cwd)
       FROM agents WHERE id = $1`,
      [id, input.type, message, JSON.stringify(input.metadata ?? {})]
    )
    .catch((err) =>
      logger.warn({ err }, "Failed to insert agent event history")
    );
}

/**
 * Conditional variant of `writeLatestEvent`. Only updates the agent's
 * latest-event columns when `latest_event_updated_at` still matches
 * `expectedUpdatedAt` — i.e. no other event was written between the
 * caller's read and this write. Returns `true` when the row was updated,
 * `false` when the precondition failed (another event landed first).
 */
export async function writeLatestEventIfCurrent(
  pool: Pool,
  logger: FastifyBaseLogger,
  id: string,
  expectedUpdatedAt: string,
  input: AgentLatestEventInput
): Promise<boolean> {
  const message = input.message.trim();
  if (!message) {
    throw new AgentError(
      "Latest event message must be a non-empty string.",
      400
    );
  }

  const result = await pool.query(
    `
    UPDATE agents
    SET latest_event_type = $2,
        latest_event_message = $3,
        latest_event_metadata = $4::jsonb,
        latest_event_updated_at = NOW(),
        updated_at = NOW()
    WHERE id = $1 AND deleted_at IS NULL
      AND latest_event_updated_at::text = $5
    `,
    [
      id,
      input.type,
      message,
      JSON.stringify(input.metadata ?? {}),
      expectedUpdatedAt,
    ]
  );

  if (result.rowCount !== 1) {
    return false;
  }

  pool
    .query(
      `INSERT INTO agent_events (agent_id, event_type, message, metadata, agent_type, agent_name, project_dir)
       SELECT $1, $2, $3, $4::jsonb, type, name, COALESCE(git_context->>'repoRoot', cwd)
       FROM agents WHERE id = $1`,
      [id, input.type, message, JSON.stringify(input.metadata ?? {})]
    )
    .catch((err) =>
      logger.warn({ err }, "Failed to insert agent event history")
    );

  return true;
}

export type AgentEventBus = {
  /** Register a callback invoked after every successful upsert + agent fetch. */
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
 * In-memory pub/sub for agent latest-event updates. Listeners are invoked
 * in registration order. The bus deliberately swallows listener errors
 * (sync throws *and* async rejections) so a buggy SSE writer cannot poison
 * the data layer that drove the event.
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
