/**
 * Runtime-free wire contract for the `/api/v1/events` SSE stream.
 *
 * `SharedUiEvent` covers every member both sides can agree on. Four members
 * are deliberately left out and stay declared per side — see the comment on
 * `SharedUiEvent` for why.
 */

import type {
  StreamChangedEvent,
  StreamEntryEvent,
  StreamReadEvent,
} from "./block-types.js";

/**
 * The SSE members both sides agree on.
 *
 * NOT here, on purpose — each side declares these four itself because the
 * payload types genuinely differ:
 *   - `snapshot` / `agent.upsert` — `AgentRecord` lives in `./agent-record.js`,
 *     but the payload types still differ: the server publishes it enriched
 *     with the `hasStream` flag, and the web client models the same rows with
 *     a deliberately lenient `Agent` that relaxes the always-sent columns to
 *     optional.
 *   - `agent.diff_state_changed` — web's `DiffStats` makes `excludingTests`
 *     optional so an older server can still drive a newer bundle.
 *   - `release.cached_info_changed` — `ReleaseInfoSnapshot` is declared in a
 *     runtime server module, so it cannot move here as-is; web type-imports
 *     it across the boundary instead.
 */
export type SharedUiEvent =
  | { type: "agent.deleted"; agentId: string }
  | { type: "files.changed"; agentId: string }
  | { type: "files.seen"; agentId: string; keys: string[] }
  /**
   * Ephemeral: an agent invoked an MCP tool. Not persisted, not fetched;
   * feeds the presence strip's tool blip.
   */
  | { type: "agent.tool_invoked"; agentId: string; tool: string; at: string }
  | StreamChangedEvent
  | StreamEntryEvent
  | StreamReadEvent
  | { type: "stream.started"; agentId: string }
  | { type: "stream.stopped"; agentId: string }
  | { type: "job.changed" }
  | { type: "template.changed" }
  | { type: "brain.changed"; repoRoot: string }
  | {
      type: "notification";
      notificationId: string;
      agentId: string;
      agentName: string;
      eventType: string;
      message: string;
    };
