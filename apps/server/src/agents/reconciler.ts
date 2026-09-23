import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import type { DiagnosticsRecorder } from "../diagnostics.js";

import type { AgentRuntime } from "./runtime.js";
import type { AgentRecord, AgentStatus } from "./types.js";

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
 * How long an agent can sit in `creating` with no host before it is
 * treated as a failed launch. Creating covers the worktree and dependency
 * install, which can legitimately take minutes.
 */
const CREATING_GRACE_S = 15 * 60;
export const RECONNECT_WARNING =
  "Agent host is alive, but Dispatch cannot reconnect yet. Retrying automatically.";

export type ReconcilerDeps = {
  pool: Pool;
  logger: FastifyBaseLogger;
  runtime: AgentRuntime;
  diagnostics: DiagnosticsRecorder;
  getAgent: (id: string) => Promise<AgentRecord | null>;
  setAgentStatus: (
    id: string,
    status: AgentStatus,
    lastError: string | null
  ) => Promise<void>;
  notifyBlocked: (id: string, message: string) => Promise<void>;
  setReconnectProgress: (
    id: string,
    phase: "trying" | "waiting" | null
  ) => Promise<void>;
  /** Settle stream rows a dead host left open. */
  settleStream: (id: string, reason: string) => Promise<number>;
};

export type Reconciler = {
  /**
   * Status pass: flip agents whose host vanished out from under them to
   * `stopped`/`error`, and rescue agents stuck in `stopping`. Returns the
   * agents whose status the reconciler changed so the caller can
   * re-broadcast them.
   */
  reconcileAgentStatuses(): Promise<AgentRecord[]>;
  /**
   * Stop hosts whose DB records say the agent is in a terminal state.
   * No-op when the runtime has no processes.
   */
  cleanupOrphanedHosts(): Promise<void>;
};

export function createReconciler(deps: ReconcilerDeps): Reconciler {
  return {
    reconcileAgentStatuses: () => reconcileAgentStatuses(deps),
    cleanupOrphanedHosts: () => cleanupOrphanedHosts(deps),
  };
}

async function reconcileAgentStatuses(
  deps: ReconcilerDeps
): Promise<AgentRecord[]> {
  const { pool, logger, runtime, diagnostics } = deps;

  await diagnostics.maybeMaintenanceLogs();

  const result = await pool.query<{
    id: string;
    status: string;
    updatedAt: string;
    lastError: string | null;
  }>(
    `SELECT id, status, updated_at AS "updatedAt", last_error AS "lastError" FROM agents
      WHERE deleted_at IS NULL
        AND status IN ('running', 'stopping', 'creating', 'archiving')`
  );

  const reconciled: AgentRecord[] = [];

  // Reattach attempts can each wait for a hello timeout. Probe eligible
  // hosts together so several busy hosts do not stall the whole pass in
  // sequence (including cleanup of genuinely orphaned hosts afterward).
  const attachResults = new Map(
    await Promise.all(
      result.rows
        .filter(
          (row) =>
            runtime.tracksProcesses() &&
            (row.status === "running" || row.status === "creating") &&
            !(
              row.status === "creating" &&
              (Date.now() - new Date(row.updatedAt).getTime()) / 1000 <
                CREATING_GRACE_S
            )
        )
        .map(async (row) => {
          if (row.status === "running" && row.lastError === RECONNECT_WARNING) {
            await deps.setReconnectProgress(row.id, "trying");
          }
          const attached = await runtime.attach(row.id);
          return [
            row.id,
            {
              attached,
              alive: attached || (await runtime.isAlive(row.id)),
            },
          ] as const;
        })
    )
  );

  for (const row of result.rows) {
    const stuckSeconds =
      (Date.now() - new Date(row.updatedAt).getTime()) / 1000;

    if (row.status === "archiving") {
      if (stuckSeconds > STUCK_ARCHIVING_TIMEOUT_S) {
        logger.info(
          { id: row.id, stuckSeconds },
          "Found agent stuck in archiving state — will be resumed"
        );
        const agent = await deps.getAgent(row.id);
        if (agent) reconciled.push(agent);
      }
      continue;
    }

    // Missing-host reconciliation only makes sense when the runtime has
    // real processes. Inert mode has nothing to lose.
    if (!runtime.tracksProcesses()) continue;

    // The host is spawned at the end of `creating`; before that there is
    // legitimately nothing to find.
    if (row.status === "creating" && stuckSeconds < CREATING_GRACE_S) {
      continue;
    }

    // A running/creating row gets a reconnect attempt, not just a pid
    // check: a host that is alive but didn't answer `hello` in time (busy
    // journal replay, boot contention) must not read as gone. Falling back
    // to isAlive keeps a merely-unreachable host "running" so the next
    // reconcile pass can retry attach — it never mistakes "not attached
    // yet" for "not there".
    const probe = attachResults.get(row.id);
    const alive =
      row.status === "running" || row.status === "creating"
        ? (probe?.alive ?? false)
        : await runtime.isAlive(row.id);
    if (!alive) {
      const logTail = await runtime.readLogTail(row.id);
      const launchFailed = row.status === "creating";
      const nextStatus: AgentStatus = launchFailed ? "error" : "stopped";
      const baseMessage = launchFailed
        ? "Launch failed before the agent became ready."
        : "The agent is no longer running.";
      await deps.settleStream(row.id, "the agent stopped");
      await deps.setAgentStatus(row.id, nextStatus, logTail || null);
      await deps.setReconnectProgress(row.id, null);
      if (launchFailed) {
        await deps.notifyBlocked(
          row.id,
          logTail ? `${baseMessage}\n${logTail}` : baseMessage
        );
      }
      const agent = await deps.getAgent(row.id);
      if (agent) reconciled.push(agent);
    } else if (row.status === "running" && probe) {
      // Keep a reconnect warning visible without treating a live host as
      // stopped. Only write when it changes, so periodic probes stay quiet.
      if (!probe.attached && row.lastError !== RECONNECT_WARNING) {
        await deps.setAgentStatus(row.id, "running", RECONNECT_WARNING);
      } else if (probe.attached && row.lastError === RECONNECT_WARNING) {
        await deps.setAgentStatus(row.id, "running", null);
      }
      await deps.setReconnectProgress(
        row.id,
        probe.attached ? null : "waiting"
      );
    } else if (
      row.status === "stopping" &&
      stuckSeconds > STUCK_STOPPING_TIMEOUT_S
    ) {
      logger.warn(
        { id: row.id, stuckSeconds },
        "Agent stuck in stopping state, reverting to running"
      );
      await deps.setAgentStatus(row.id, "running", null);
      const agent = await deps.getAgent(row.id);
      if (agent) reconciled.push(agent);
    }
  }

  return reconciled;
}

async function cleanupOrphanedHosts(deps: ReconcilerDeps): Promise<void> {
  const { pool, logger, runtime } = deps;
  const hosted = await runtime.listHosted();
  if (hosted.length === 0) return;

  const dbResult = await pool.query<{ id: string; status: string }>(
    `SELECT id, status FROM agents WHERE deleted_at IS NULL AND id = ANY($1::text[])`,
    [hosted]
  );
  const statuses = new Map(dbResult.rows.map((row) => [row.id, row.status]));

  for (const agentId of hosted) {
    const status = statuses.get(agentId);
    // Agent in a terminal state: the host is definitely orphaned.
    if (status === "stopped" || status === "error") {
      logger.info(
        { agentId, status },
        "Stopping orphaned agent host (agent in terminal state)"
      );
      await runtime.stop(agentId, true).catch(() => {});
      continue;
    }
    // No DB record: leave it alone. The host may belong to another server
    // instance sharing the state root; only act on agents this database
    // knows about.
    if (!status) {
      logger.debug(
        { agentId },
        "Ignoring agent host with no matching DB record"
      );
    }
  }
}
