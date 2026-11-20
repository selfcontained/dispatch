import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import { MANAGED_WORKSPACE, remotePlacement } from "@dispatch/runner-protocol";
import {
  archiveCheckoutState,
  nativeBorrowers,
  observeArchiveCheckout,
  releaseRemoteCheckout,
  rememberArchiveCheckoutState,
  type ArchiveCheckoutAgent,
  type LocalArchiveRunner,
} from "./archive-checkout.js";
import type { RemoteRunnerService } from "./remote/service.js";
import { runLifecycleHook } from "./lifecycle-hooks.js";
import { AgentError } from "./errors.js";
import type { AgentRuntime } from "./runtime.js";
import type {
  AgentRecord,
  AgentStatus,
  ArchivePhase,
  WorktreeCleanupMode,
} from "./types.js";

export type ArchiveDeps = {
  pool: Pool;
  logger: FastifyBaseLogger;
  runtime: AgentRuntime;
  localRunner: LocalArchiveRunner;
  remote?: RemoteRunnerService;
  diffStatsRefresher: { clear(agentId: string): void } | null;
  getAgent: (id: string) => Promise<AgentRecord | null>;
  getRequiredAgent: (id: string) => Promise<AgentRecord>;
  setAgentStatus: (
    id: string,
    status: AgentStatus,
    lastError: string | null
  ) => Promise<void>;
  /** The stop about to happen is deliberate: the turn it cuts is not a failure. */
  beginStopStream: (id: string) => void;
  /** Settle stream rows the stopped host left open, as stopped. */
  settleStream: (id: string) => Promise<number>;
  setArchivePhase: (id: string, phase: ArchivePhase) => Promise<void>;
};

/**
 * Children go with the parent, worktrees included. The parent's confirmation is
 * the one answer for the whole cascade. Native children retain the legacy
 * force policy. Runner-managed children use automatic cleanup.
 */
const CASCADED_CHILD_CLEANUP: WorktreeCleanupMode = "force";

/**
 * True children and review agents requested by this agent go with it.
 * Other `launched_by_agent_id` agents remain independent (`child: false`).
 * An agent already `archiving` belongs to its own archive, which cascades itself.
 */
async function getChildAgentIds(
  pool: Pool,
  parentAgentId: string
): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    `SELECT id
     FROM agents
     WHERE (parent_agent_id = $1 OR (role = 'review' AND launched_by_agent_id = $1))
       AND deleted_at IS NULL
       AND status != 'archiving'`,
    [parentAgentId]
  );
  return result.rows.map((row) => row.id);
}

/** Returns whether cleanup should be retried after archive. */
export async function cleanupAgentWorktree(
  pool: Pool,
  logger: FastifyBaseLogger,
  localRunner: LocalArchiveRunner,
  agent: ArchiveCheckoutAgent,
  mode: WorktreeCleanupMode,
  durations: Record<string, number>,
  onCleanupStart?: () => Promise<void>
): Promise<boolean> {
  const { id, worktreePath } = agent;
  if (!worktreePath || remotePlacement(agent.cwd) || mode === "keep")
    return false;
  try {
    const started = Date.now();
    const expectedState = await archiveCheckoutState(pool, id);
    const { checkout, borrowers } = await observeArchiveCheckout(
      pool,
      agent,
      localRunner
    );
    if (
      !checkout ||
      (expectedState !== null && checkout.stateId !== expectedState) ||
      (mode === "auto" &&
        (checkout.unmerged || checkout.uncommittedFiles.length))
    )
      return false;
    durations.outstandingChangesCheck = Date.now() - started;
    if (borrowers.length) {
      await rememberArchiveCheckoutState(pool, id, checkout.stateId);
      return true;
    }
    await onCleanupStart?.();
    if ((await nativeBorrowers(pool, agent, checkout.path)).length) {
      await rememberArchiveCheckoutState(pool, id, checkout.stateId);
      return true;
    }

    const cleanupStarted = Date.now();
    await localRunner.checkoutRelease(agent, {
      kind: "release",
      expectedState: checkout.stateId,
    });
    durations.worktreeCleanup = Date.now() - cleanupStarted;
    return false;
  } catch (err) {
    logger.warn(
      { err, agentId: id, worktreePath },
      "Worktree cleanup failed; leaving on disk."
    );
    return false;
  }
}

function managedCheckout(agent: Pick<AgentRecord, "runnerManaged" | "cwd">) {
  return (
    Boolean(agent.runnerManaged) ||
    remotePlacement(agent.cwd)?.workspace === MANAGED_WORKSPACE
  );
}

async function finishCheckout(
  deps: ArchiveDeps,
  agent: AgentRecord,
  mode: WorktreeCleanupMode,
  stopped: boolean,
  durations: Record<string, number>,
  onCleanupStart?: () => Promise<void>
) {
  if (!managedCheckout(agent)) {
    return cleanupAgentWorktree(
      deps.pool,
      deps.logger,
      deps.localRunner,
      agent,
      mode,
      durations,
      onCleanupStart
    );
  }
  if (!stopped || !deps.remote) return true;
  try {
    await onCleanupStart?.();
    return (
      (await releaseRemoteCheckout(deps.pool, agent, mode, deps.remote)) ===
      "inUse"
    );
  } catch (err) {
    deps.logger.warn(
      { err, agentId: agent.id },
      "Runner checkout release remains pending."
    );
    return true;
  }
}

export async function beginArchive(
  deps: ArchiveDeps,
  id: string,
  cleanupWorktree: WorktreeCleanupMode = "auto",
  checkoutState: string | null = null
): Promise<AgentRecord> {
  const { pool } = deps;

  const result = await pool.query(
    `UPDATE agents
     SET status = 'archiving', archive_phase = 'stopping', archive_cleanup_mode = $2, archive_checkout_state = $3, updated_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL AND status != 'archiving'
     RETURNING id`,
    [id, cleanupWorktree, checkoutState]
  );

  if (result.rowCount === 0) {
    const existing = await deps.getAgent(id);
    if (!existing) {
      throw new AgentError("Agent not found.", 404);
    }
    throw new AgentError("Agent is already being archived.", 409);
  }

  return await deps.getRequiredAgent(id);
}

export async function executeArchive(
  deps: ArchiveDeps,
  id: string,
  callbacks: {
    onPhaseChange: (agent: AgentRecord) => void;
    onComplete: (deletedIds: string[]) => void;
    onError: (error: unknown) => void;
  }
): Promise<void> {
  const { pool, logger, runtime, diffStatsRefresher } = deps;
  const deleteStart = Date.now();
  const durations: Record<string, number> = {};

  try {
    const agent = await deps.getRequiredAgent(id);
    const cleanupWorktree = agent.archiveCleanupMode ?? "auto";
    let stopped = false;

    // Phase: stopping — tear down session without changing agent status
    const t = Date.now();
    try {
      await runLifecycleHook("stop", agent, logger, deps.remote).catch((err) =>
        logger.warn(
          { err, agentId: id },
          "Stop hook failed during archive; continuing"
        )
      );
      deps.beginStopStream(id);
      await runtime.stop(id, true);
      await deps.settleStream(id);
      // The state directory holds the launch file with the MCP token; the
      // stream is already in the database.
      if (managedCheckout(agent)) await runtime.clearRemoteState?.(id);
      else await runtime.discard(id);
      stopped = true;
    } catch (err) {
      logger.warn(
        { err, agentId: id },
        "Stop during archive failed; continuing"
      );
    }
    durations.stop = Date.now() - t;

    const publishPhase = async (phase: ArchivePhase) => {
      await deps.setArchivePhase(id, phase);
      const updated = await deps.getAgent(id);
      if (updated) callbacks.onPhaseChange(updated);
    };

    // Stop dependents before removing this checkout. Reviewers can share it
    // through cwd while their display parent is elsewhere.
    const tCascade = Date.now();
    const cascadedIds: string[] = [];
    try {
      const childIds = await getChildAgentIds(pool, id);
      for (const childId of childIds) {
        try {
          cascadedIds.push(...(await deleteAgentDirect(deps, childId)));
        } catch (err) {
          logger.warn(
            { err, childId, parentId: id },
            "Failed to cascade-delete child agent"
          );
        }
      }
      if (childIds.length > 0) {
        durations.cascadeChildren = Date.now() - tCascade;
      }
    } catch (err) {
      logger.warn(
        { err, agentId: id },
        "Failed to look up child agents during cascade; children may be orphaned"
      );
    }

    // Phase: worktree-check
    await publishPhase("worktree-check");

    const runnerCleanupPending = await finishCheckout(
      deps,
      agent,
      cleanupWorktree,
      stopped,
      durations,
      () => publishPhase("worktree-cleanup")
    );

    // Phase: finalizing
    await publishPhase("finalizing");

    const tDb = Date.now();

    await pool.query(
      "UPDATE agents SET deleted_at = NOW(), archive_phase = NULL, archive_cleanup_mode = CASE WHEN $2 THEN archive_cleanup_mode END, archive_checkout_state = CASE WHEN $2 THEN archive_checkout_state END, runner_cleanup_pending = $2, updated_at = NOW() WHERE id = $1",
      [id, runnerCleanupPending]
    );
    durations.db = Date.now() - tDb;
    diffStatsRefresher?.clear(id);

    durations.total = Date.now() - deleteStart;
    const parts = Object.entries(durations)
      .map(([k, v]) => `${k}=${v}ms`)
      .join(", ");
    logger.info({ agentId: id, durations }, `Archive durations: ${parts}`);

    const deletedIds = [id, ...cascadedIds];
    callbacks.onComplete(deletedIds);
  } catch (error) {
    logger.error({ err: error, agentId: id }, "Archive failed");
    try {
      await deps.setAgentStatus(
        id,
        "error",
        error instanceof Error ? error.message : "Archive failed"
      );
      await deps.setArchivePhase(id, null);
    } catch {
      /* best effort */
    }
    callbacks.onError(error);
  }
}

/**
 * Deletes one agent and every true child beneath it, returning the ids removed.
 * Callers publish `agent.deleted` per id, so anything missing here leaves the
 * UI rendering an agent the database no longer has.
 */
export async function deleteAgentDirect(
  deps: ArchiveDeps,
  id: string
): Promise<string[]> {
  const { pool, logger, runtime, diffStatsRefresher } = deps;
  const deleteStart = Date.now();
  const durations: Record<string, number> = {};
  const agent = await deps.getRequiredAgent(id);

  const mode = managedCheckout(agent) ? "auto" : CASCADED_CHILD_CLEANUP;
  // Claim before any teardown — an agent's own archive and an ancestor's
  // cascade can reach it at once. Same CAS `beginArchive` takes.
  const claimed = await pool.query(
    `UPDATE agents
     SET status = 'archiving', archive_phase = 'stopping', archive_cleanup_mode = $2, updated_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL AND status != 'archiving'
     RETURNING id`,
    [id, mode]
  );
  if (claimed.rowCount === 0) {
    logger.info(
      { agentId: id },
      "Agent is already being archived or deleted; skipping cascade."
    );
    return [];
  }

  let stopped = false;
  if (agent.status !== "stopped" || managedCheckout(agent)) {
    const t = Date.now();
    // Not stopAgent: it writes `stopping`/`stopped`, releasing the claim above
    // and letting a fresh archive take this agent mid-teardown.
    try {
      await runLifecycleHook("stop", agent, logger, deps.remote).catch((err) =>
        logger.warn(
          { err, agentId: id },
          "Stop hook failed during delete; continuing"
        )
      );
      deps.beginStopStream(id);
      await runtime.stop(id, true);
      await deps.settleStream(id);
      // The state directory holds the launch file with the MCP token; the
      // stream is already in the database.
      if (managedCheckout(agent)) await runtime.clearRemoteState?.(id);
      else await runtime.discard(id);
      stopped = true;
    } catch (err) {
      logger.warn(
        { err, agentId: id },
        "Stop during delete failed; continuing with deletion"
      );
    }
    durations.stop = Date.now() - t;
  }

  // The archive claim excludes this row from dependent lookup, preventing
  // cycles. Stop dependents before cleaning up their shared checkout.
  const deletedIds = [id];
  try {
    const childIds = await getChildAgentIds(pool, id);
    for (const childId of childIds) {
      try {
        deletedIds.push(...(await deleteAgentDirect(deps, childId)));
      } catch (err) {
        logger.warn(
          { err, childId, parentId: id },
          "Failed to cascade-delete child agent"
        );
      }
    }
  } catch (err) {
    logger.warn(
      { err, agentId: id },
      "Failed to look up child agents during cascade; children may be orphaned"
    );
  }

  durations.total = Date.now() - deleteStart;
  const parts = Object.entries(durations)
    .map(([k, v]) => `${k}=${v}ms`)
    .join(", ");
  logger.info({ agentId: id, durations }, `Archive durations: ${parts}`);

  const tDb = Date.now();

  // Keeping it would leave a worktree no agent record can reach.
  const runnerCleanupPending = await finishCheckout(
    deps,
    agent,
    mode,
    stopped,
    durations
  );

  await pool.query(
    `UPDATE agents
     SET deleted_at = NOW(), archive_phase = NULL, archive_cleanup_mode = CASE WHEN $2 THEN archive_cleanup_mode END, archive_checkout_state = CASE WHEN $2 THEN archive_checkout_state END, runner_cleanup_pending = $2, updated_at = NOW()
     WHERE id = $1`,
    [id, runnerCleanupPending]
  );
  durations.db = Date.now() - tDb;
  diffStatsRefresher?.clear(id);

  return deletedIds;
}
