/**
 * Runtime-free wire contract for the `/api/v1/events` SSE stream.
 *
 * `SharedUiEvent` covers every member both sides can agree on. Four members
 * are deliberately left out and stay declared per side — see the comment on
 * `SharedUiEvent` for why.
 */

import type { ChatChangedEvent } from "./chat-types.js";
import type { SurfaceChangedEvent } from "./surface-types.js";

/**
 * Terminal copy-mode payloads. Carried by the `agent.terminal_state_changed`
 * event and also returned by `GET /api/v1/agents/:id/terminal-state`.
 */
export type TerminalCopyMode = "live" | "copy" | "exiting";

export type TerminalUiState = {
  copyMode: TerminalCopyMode;
  lastObservedAt: number;
};

export type InjectionHoldState = {
  // True while a delivery is actively waiting out the user-activity quiet gate.
  held: boolean;
  // Gated injections enqueued but not yet delivered (includes the held one).
  pendingCount: number;
  // The quiet window the gate waits for, so clients can render delivery ETA
  // from their own local typing activity.
  quietMs: number;
};

/**
 * The SSE members both sides agree on.
 *
 * All but two were already declared identically on each side. The exceptions
 * are `review.updated` and `review_feedback.updated`, where the web copy
 * listed only `agentId`: the server has published `reviewId`/`status` and
 * `feedbackItemId` on these ever since the events were introduced (#730, same
 * commit as the web copy), and does so at every publish site in
 * `server/mcp-review-handlers.ts` and `routes/reviews.ts`. So this is drift
 * being closed, not a contract being narrowed — there is no server old enough
 * to send these events without those fields, which is what separates them
 * from the version-skew exclusions listed below.
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
  | {
      type: "agent.terminal_state_changed";
      agentId: string;
      terminalState: TerminalUiState;
    }
  | {
      type: "agent.injection_hold_changed";
      agentId: string;
      holdState: InjectionHoldState;
    }
  | { type: "agent.deleted"; agentId: string }
  | { type: "media.changed"; agentId: string }
  | {
      type: "whiteboard.changed";
      agentId: string;
      version: number;
      source: "user" | "agent";
    }
  | { type: "media.seen"; agentId: string; keys: string[] }
  | {
      type: "message.created";
      senderAgentId: string;
      recipientAgentId: string;
    }
  | { type: "message.read"; agentId: string }
  | SurfaceChangedEvent
  | ChatChangedEvent
  | { type: "stream.started"; agentId: string }
  | { type: "stream.stopped"; agentId: string }
  | {
      type: "review.created";
      agentId: string;
      reviewId: number;
      reviewerAgentId?: string | null;
    }
  | {
      type: "review.updated";
      agentId: string;
      reviewId: number;
      status: string;
    }
  | {
      type: "review_feedback.updated";
      agentId: string;
      feedbackItemId: number;
    }
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
