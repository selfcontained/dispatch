import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import type { DiagnosticsRecorder } from "../diagnostics.js";

import type { AgentRuntime } from "./runtime.js";
import { agentIdFromSessionName } from "./tmux/session-name.js";
import type {
  AgentLatestEventInput,
  AgentRecord,
  AgentStatus,
} from "./types.js";

/**
 * How long an agent can sit in `stopping` before the reconciler
 * concludes the stop request didn't take and reverts the row to
 * `running` (so the user can try again, e.g. with force).
 */
const STUCK_STOPPING_TIMEOUT_S = 60;

/**
 * How long an agent can sit in `archiving` before the reconciler
 * surfaces it as needing attention. The archive flow is fire-and-forget
 * so we want to nudge it back into the SSE stream when it's stuck.
 */
const STUCK_ARCHIVING_TIMEOUT_S = 30;

/**
 * Manager-side helpers the reconciler needs to read/write agent state.
 * Wired up by `AgentManager`'s constructor — passed as a closure of
 * methods rather than the manager instance to keep the dependency
 * direction explicit (reconciler depends on these capabilities, not
 * on the whole manager surface).
 */
export type ReconcilerDeps = {
  pool: Pool;
  logger: FastifyBaseLogger;
  runtime: AgentRuntime;
  diagnostics: DiagnosticsRecorder;
  /** Tmux session-name prefix from `AppConfig.sessionPrefix`. */
  sessionPrefix: string;
  /** Re-fetch the full agent record after a status mutation. */
  getAgent: (id: string) => Promise<AgentRecord | null>;
  /** Persist a status transition + last_error + tmux_session. */
  setAgentStatus: (
    id: string,
    status: AgentStatus,
    lastError: string | null,
    tmuxSession?: string
  ) => Promise<void>;
  /** Emit a system-tagged latest_event (logged failures don't propagate). */
  setSystemLatestEvent: (
    id: string,
    input: AgentLatestEventInput
  ) => Promise<void>;
};

export type Reconciler = {
  /**
   * Status-only pass: flip agents whose tmux session vanished out from
   * under them to `stopped`/`error`, and rescue agents stuck in
   * `stopping`. Returns the agents whose status the reconciler changed
   * — the caller (manager) re-broadcasts these via SSE.
   *
   * Does NOT touch orphaned tmux sessions — that's a separate concern
   * exposed via `cleanupOrphanedSessions()`. The status pass and the
   * orphan-cleanup pass are kept distinct so the manager can run them
   * independently (e.g. callers that just want the changed-record
   * list shouldn't pay the cost of `tmux list-sessions` + a DB
   * IN-clause query for every status reconciliation tick).
   */
  reconcileAgentStatuses(): Promise<AgentRecord[]>;

  /**
   * Find tmux sessions whose DB records say the agent is in a terminal
   * state and kill them. No-op when the runtime doesn't track sessions
   * (`runtime.listSessions` returns `[]`).
   */
  cleanupOrphanedSessions(): Promise<void>;
};

/**
 * Build a reconciler bound to the given pool + runtime + diagnostics.
 * The factory is the unit of construction; the manager creates one in
 * its constructor and calls both methods from `reconcileAgents()`,
 * but exposes only the status pass via `AgentManager#reconcileAgentStatuses`
 * so the historical contract (status-only) is preserved.
 */
export function createReconciler(deps: ReconcilerDeps): Reconciler {
  return {
    async reconcileAgentStatuses(): Promise<AgentRecord[]> {
      return reconcileAgentStatuses(deps);
    },
    async cleanupOrphanedSessions(): Promise<void> {
      return cleanupOrphanedSessions(deps);
    },
  };
}

async function reconcileAgentStatuses(
  deps: ReconcilerDeps
): Promise<AgentRecord[]> {
  const { pool, logger, runtime, diagnostics } = deps;

  // Diagnostics tickers live on the periodic-reconcile path so they
  // run regardless of whether anything needs reconciling.
  await diagnostics.maybeCaptureTmuxInventory();
  await diagnostics.maybeMaintenanceLogs();

  const result = await pool.query(
    // Shadow rows (peer_id set) have no local pane by design — their status is
    // mirrored from the owning peer, so local tmux reconciliation must skip them.
    "SELECT id, tmux_session AS \"tmuxSession\", status, updated_at AS \"updatedAt\" FROM agents WHERE deleted_at IS NULL AND peer_id IS NULL AND status IN ('running', 'stopping', 'creating', 'archiving')"
  );

  const reconciled: AgentRecord[] = [];

  for (const row of result.rows as Array<{
    id: string;
    tmuxSession: string | null;
    status: string;
    updatedAt: string;
  }>) {
    // Archiving agents are handled separately — only resume if stuck
    // for > STUCK_ARCHIVING_TIMEOUT_S so a fast archive doesn't trip
    // the recovery path.
    if (row.status === "archiving") {
      const stuckSeconds =
        (Date.now() - new Date(row.updatedAt).getTime()) / 1000;
      if (stuckSeconds > STUCK_ARCHIVING_TIMEOUT_S) {
        logger.info(
          { id: row.id, stuckSeconds },
          "Found agent stuck in archiving state — will be resumed"
        );
        const agent = await deps.getAgent(row.id);
        if (agent) {
          reconciled.push(agent);
        }
      }
      continue;
    }

    // Missing-session reconciliation only makes sense when the runtime
    // actually tracks session state. Inert mode has no real sessions
    // to lose, so a missing-session result there is just a statement
    // of fact, not a reason to flip the agent to stopped.
    if (!runtime.tracksSessions()) {
      continue;
    }

    const exists = row.tmuxSession
      ? await runtime.hasSession(row.tmuxSession)
      : false;

    if (!exists) {
      // We've already gated on tracksSessions(), so reaching here
      // means we're definitively in a session-tracking runtime.
      const exitInfo = row.tmuxSession
        ? await runtime.readExitInfo(row.tmuxSession)
        : null;
      if (row.tmuxSession) {
        await diagnostics.captureMissingSessionIncident({
          agentId: row.id,
          tmuxSession: row.tmuxSession,
          status: row.status,
          updatedAt: row.updatedAt,
          exitInfo,
        });
      }
      if (exitInfo !== null) {
        logger.info(
          { id: row.id, exitCode: exitInfo },
          "Agent process exited with code %d",
          exitInfo
        );
      }
      const setupLogTail = await runtime.readSetupLogTail(row.id);
      const errorDetail = setupLogTail || null;
      const launchFailed =
        row.status === "creating" || (exitInfo !== null && exitInfo !== 0);
      const nextStatus: AgentStatus = launchFailed ? "error" : "stopped";
      const baseMessage = launchFailed
        ? row.status === "creating"
          ? exitInfo !== null
            ? `Launch failed with exit code ${exitInfo}.`
            : "Launch failed before the session became ready."
          : exitInfo !== null
            ? `Session exited with code ${exitInfo}.`
            : "Session ended unexpectedly."
        : "Session ended normally.";
      await deps.setAgentStatus(
        row.id,
        nextStatus,
        errorDetail,
        row.tmuxSession ?? undefined
      );
      await deps.setSystemLatestEvent(row.id, {
        type: launchFailed ? "blocked" : "idle",
        message: setupLogTail ? `${baseMessage}\n${setupLogTail}` : baseMessage,
        metadata: {
          source: "system",
          ...(exitInfo !== null ? { exitCode: exitInfo } : {}),
          launchFailed,
        },
      });
      const agent = await deps.getAgent(row.id);
      if (agent) {
        reconciled.push(agent);
      }
    } else if (row.status === "stopping") {
      const stuckSeconds =
        (Date.now() - new Date(row.updatedAt).getTime()) / 1000;
      if (stuckSeconds > STUCK_STOPPING_TIMEOUT_S) {
        logger.warn(
          { id: row.id, stuckSeconds },
          "Agent stuck in stopping state, reverting to running"
        );
        await deps.setAgentStatus(
          row.id,
          "running",
          null,
          row.tmuxSession ?? undefined
        );
        await deps.setSystemLatestEvent(row.id, {
          type: "working",
          message:
            "Stop timed out — agent reverted to running. Try force stop.",
          metadata: { source: "system" },
        });
        const agent = await deps.getAgent(row.id);
        if (agent) {
          reconciled.push(agent);
        }
      }
    }
  }

  return reconciled;
}

async function cleanupOrphanedSessions(deps: ReconcilerDeps): Promise<void> {
  const { pool, logger, runtime, sessionPrefix } = deps;
  const prefix = `${sessionPrefix}_agt_`;
  const sessions = await runtime.listSessions(prefix);
  if (sessions.length === 0) return;

  const agentIds = sessions.map((s) => agentIdFromSessionName(s.name));
  const placeholders = agentIds.map((_, i) => `$${i + 1}`).join(", ");
  const dbResult = await pool.query(
    `SELECT id, status FROM agents WHERE deleted_at IS NULL AND id IN (${placeholders})`,
    agentIds
  );
  const dbAgents = new Map<string, string>();
  for (const row of dbResult.rows as Array<{ id: string; status: string }>) {
    dbAgents.set(row.id, row.status);
  }

  const toKill: string[] = [];
  for (const session of sessions) {
    const agentId = agentIdFromSessionName(session.name);
    const status = dbAgents.get(agentId);

    // Agent in terminal state — session is definitely orphaned.
    if (status === "stopped" || status === "error") {
      logger.info(
        { session: session.name, agentId, status },
        "Killing orphaned tmux session (agent in terminal state)"
      );
      toKill.push(session.name);
      continue;
    }

    // No DB record — leave it alone. The session may belong to another
    // server instance using the same tmux namespace; only clean up
    // sessions that *this* database definitively knows about.
    if (!status) {
      logger.debug(
        { session: session.name, agentId },
        "Ignoring tmux session with no matching DB record"
      );
    }
  }

  await Promise.all(toKill.map((name) => runtime.killSession(name)));
}
