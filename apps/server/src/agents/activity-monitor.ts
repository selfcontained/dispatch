import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import { TmuxTerminal } from "../terminal/tmux-terminal.js";
import type { AgentLatestEventInput, AgentLatestEventType } from "./types.js";

/**
 * How long a pane must be silent before correcting `working` → `idle`.
 * Set conservatively — agent CLIs can pause for extended thinking phases
 * that produce no visible output, so too short a window risks false
 * positives.
 */
const STALE_WORKING_MS = 180_000; // 3 minutes

/**
 * Number of recent pane lines to capture for change detection. Enough to
 * detect output scrolling without capturing the entire scrollback.
 */
const CAPTURE_LINES = 100;

type AgentActivityRow = {
  id: string;
  tmuxSession: string;
  latestEventType: AgentLatestEventType | null;
  latestEventUpdatedAt: string | null;
};

type ActivityState = {
  lastDigest: string;
  lastChangeAt: number;
};

export type ActivityMonitorDeps = {
  pool: Pool;
  logger: FastifyBaseLogger;
  /** Conditionally write a corrective event — only succeeds if the
   *  agent's latest event hasn't changed since `expectedUpdatedAt`. */
  correctLatestEvent: (
    id: string,
    expectedUpdatedAt: string,
    input: AgentLatestEventInput
  ) => Promise<boolean>;
};

export type ActivityMonitor = {
  /** Run one activity-check pass across all running agents. */
  check(): Promise<{ agentsScanned: number; corrections: number }>;
  /** Drop tracked state for an agent (e.g. on stop/archive). */
  forget(agentId: string): void;
};

/**
 * Server-side activity monitor that compares each running agent's
 * self-reported status against observed tmux pane activity.
 *
 * Corrections:
 *   - Pane active + status is blocked/idle/done/waiting_user → working
 *   - Pane stale (3+ min) + status is working → idle
 *
 * Corrections are conditional — they only apply when the agent's latest
 * event hasn't changed between the monitor's read and write, preventing
 * a stale snapshot from overwriting a newer agent-reported event.
 *
 * Runs on the same cadence as the reconciler (called from the reconcile
 * loop) but is a separate concern — the reconciler handles session
 * lifecycle, the activity monitor handles status accuracy.
 */
export function createActivityMonitor(
  deps: ActivityMonitorDeps
): ActivityMonitor {
  const state = new Map<string, ActivityState>();

  return {
    async check(): Promise<{ agentsScanned: number; corrections: number }> {
      const { pool, logger } = deps;
      let corrections = 0;

      const result = await pool.query(
        `SELECT id,
                tmux_session   AS "tmuxSession",
                latest_event_type AS "latestEventType",
                latest_event_updated_at::text AS "latestEventUpdatedAt"
         FROM agents
         WHERE deleted_at IS NULL
           AND status = 'running'
           AND tmux_session IS NOT NULL`
      );

      const runningIds = new Set<string>();

      for (const row of result.rows as AgentActivityRow[]) {
        runningIds.add(row.id);

        try {
          const terminal = new TmuxTerminal(row.tmuxSession);
          if (!(await terminal.hasSession())) continue;

          const paneContent = await terminal.captureRecentLines(CAPTURE_LINES);
          const digest = terminal.digest(paneContent);

          const prev = state.get(row.id);
          const now = Date.now();

          if (!prev) {
            state.set(row.id, { lastDigest: digest, lastChangeAt: now });
            continue;
          }

          const paneChanged = prev.lastDigest !== digest;

          state.set(row.id, {
            lastDigest: digest,
            lastChangeAt: paneChanged ? now : prev.lastChangeAt,
          });

          const eventType = row.latestEventType;
          const eventUpdatedAt = row.latestEventUpdatedAt;
          if (!eventType || !eventUpdatedAt) continue;

          if (paneChanged && eventType !== "working") {
            logger.info(
              { agentId: row.id, from: eventType },
              "Activity monitor: pane active, correcting %s → working",
              eventType
            );
            const applied = await deps.correctLatestEvent(
              row.id,
              eventUpdatedAt,
              { type: "working", message: "Activity detected" }
            );
            if (!applied) {
              logger.debug(
                { agentId: row.id },
                "Activity monitor: correction skipped — event was updated concurrently"
              );
            } else {
              corrections += 1;
            }
          } else if (!paneChanged && eventType === "working") {
            const staleDurationMs = now - prev.lastChangeAt;
            if (staleDurationMs >= STALE_WORKING_MS) {
              logger.info(
                { agentId: row.id, staleDurationMs },
                "Activity monitor: pane stale for %dms, correcting working → idle",
                staleDurationMs
              );
              const applied = await deps.correctLatestEvent(
                row.id,
                eventUpdatedAt,
                { type: "idle", message: "No recent activity detected" }
              );
              if (!applied) {
                logger.debug(
                  { agentId: row.id },
                  "Activity monitor: correction skipped — event was updated concurrently"
                );
              } else {
                corrections += 1;
              }
            }
          }
        } catch (err) {
          logger.debug(
            { err, agentId: row.id },
            "Activity monitor: failed to check agent pane"
          );
        }
      }

      // Prune state for agents no longer running
      for (const id of state.keys()) {
        if (!runningIds.has(id)) {
          state.delete(id);
        }
      }

      return { agentsScanned: result.rows.length, corrections };
    },

    forget(agentId: string): void {
      state.delete(agentId);
    },
  };
}
