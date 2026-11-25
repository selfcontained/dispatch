import { usesBoundArchiveRelease } from "../runners/enrolled/checkout.js";
import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import { MANAGED_WORKSPACE, remotePlacement } from "@dispatch/runner-protocol";
import {
  archiveRunner,
  releaseRemoteCheckout,
  type ArchiveCheckoutAgent,
  type LocalArchiveRunner,
} from "./archive-checkout.js";
import {
  cascadeMode,
  finishArchiveCheckout,
  localArchiveExecutor,
  type ArchiveCheckoutHooks,
  type ArchiveOutcome,
} from "./archive-policy.js";
import type { RunnerComposition } from "../runners/directory.js";
import type { Runner } from "@dispatch/runner-protocol/contract";
import type { RemoteRunnerService } from "./remote/service.js";
import { runLifecycleHook } from "./lifecycle-hooks.js";
import { AgentError, LifecycleSuperseded } from "./errors.js";
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
  /** The local runner child serves stop hooks and release for bound checkouts. */
  localRunnerChild?: () => Runner | undefined;
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
  /** A cascade takes its archive claim against the same lifecycle as recycle. */
  claimArchive?: (
    id: string,
    claim: () => Promise<boolean>
  ) => Promise<boolean>;
  /** Resolves once the agent's runner is not held for an update. */
  waitForRunner?: (agent: AgentRecord) => Promise<boolean>;
  /** Repeats a request the runner's update fence refused, once it opens. */
  whileFenced?: <T>(
    agent: AgentRecord,
    request: () => Promise<T>
  ) => Promise<T>;
};

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

/**
 * Finish a local checkout through the shared archive sequence. Callers send
 * runner-placed agents to `releaseRemoteCheckout` instead. The runner's
 * cleanup budget, when the composition gives it one (main's 60 s on this
 * machine), bounds the whole cleanup: co-owner read, observation, removal.
 */
export async function cleanupAgentWorktree(
  pool: Pool,
  logger: FastifyBaseLogger,
  localRunner: LocalArchiveRunner,
  agent: ArchiveCheckoutAgent,
  mode: WorktreeCleanupMode,
  hooks: ArchiveCheckoutHooks | undefined,
  runner: Runner & Pick<RunnerComposition, "cleanupBudgetMs">
): Promise<ArchiveOutcome> {
  if (!agent.worktreePath) return { kind: "kept", reason: "notManaged" };
  const budget = runner.cleanupBudgetMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      finishArchiveCheckout(
        pool,
        logger,
        agent,
        mode,
        localArchiveExecutor(pool, agent, localRunner, runner),
        hooks
      ),
      ...(budget === undefined
        ? []
        : [
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(`Worktree cleanup timed out after ${budget}ms`)
                  ),
                budget
              );
            }),
          ]),
    ]);
  } catch (err) {
    logger.warn(
      { err, agentId: agent.id, worktreePath: agent.worktreePath },
      "Worktree cleanup failed; leaving on disk."
    );
    return { kind: "kept", reason: "failed" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function managedCheckout(agent: Pick<AgentRecord, "runnerManaged" | "cwd">) {
  return (
    Boolean(agent.runnerManaged) ||
    remotePlacement(agent.cwd)?.workspace === MANAGED_WORKSPACE
  );
}

/** Returns whether the checkout release stays pending for a retry. */
export async function finishCheckout(
  deps: ArchiveDeps,
  agent: AgentRecord,
  mode: WorktreeCleanupMode,
  stopped: boolean,
  durations: Record<string, number>,
  onCleanupStart?: () => Promise<void>
): Promise<boolean> {
  const hooks = { durations, onCleanupStart };
  // Every runner placement, managed or a configured workspace, finishes on
  // its runner: offline, the release stays pending and is retried.
  const outcome = remotePlacement(agent.cwd)
    ? await releaseRemoteCheckout(
        deps.pool,
        deps.logger,
        agent,
        mode,
        deps.remote,
        stopped,
        hooks
      )
    : await cleanupAgentWorktree(
        deps.pool,
        deps.logger,
        deps.localRunner,
        agent,
        mode,
        hooks,
        archiveRunner(deps.localRunnerChild, agent, agent.placement)
      );
  return outcome.kind === "pending";
}

export async function beginArchive(
  deps: ArchiveDeps,
  id: string,
  cleanupWorktree: WorktreeCleanupMode = "auto",
  checkoutState: string | null = null
): Promise<AgentRecord> {
  const { pool } = deps;

  if (checkoutState !== null && deps.remote) {
    const agent = await deps.getAgent(id);
    if (agent && usesBoundArchiveRelease(deps.remote, agent.cwd))
      checkoutState = null;
  }

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
      if ((await deps.waitForRunner?.(agent)) === false) return;
      await runLifecycleHook(
        "stop",
        agent,
        logger,
        {
          local: deps.localRunner,
          remote: deps.remote,
          child: deps.localRunnerChild,
        },
        deps.whileFenced && ((request) => deps.whileFenced!(agent, request))
      ).catch((err) => {
        if (err instanceof LifecycleSuperseded) throw err;
        logger.warn(
          { err, agentId: id },
          "Stop hook failed during archive; continuing"
        );
      });
      deps.beginStopStream(id);
      await runtime.stop(id, true);
      await deps.settleStream(id);
      // The state directory holds the launch file with the MCP token; the
      // stream is already in the database.
      if (managedCheckout(agent)) await runtime.clearRemoteState?.(id);
      else await runtime.discard(id);
      stopped = true;
    } catch (err) {
      if (err instanceof LifecycleSuperseded) return;
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

  const mode = cascadeMode();
  // Claim before any teardown — an agent's own archive and an ancestor's
  // cascade can reach it at once. Same CAS `beginArchive` takes.
  const claim = async () => {
    const result = await pool.query(
      `UPDATE agents
       SET status = 'archiving', archive_phase = 'stopping', archive_cleanup_mode = $2, updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL AND status != 'archiving'
       RETURNING id`,
      [id, mode]
    );
    return result.rowCount !== 0;
  };
  const claimed = await (deps.claimArchive?.(id, claim) ?? claim());
  if (!claimed) {
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
      if ((await deps.waitForRunner?.(agent)) === false) return [];
      await runLifecycleHook(
        "stop",
        agent,
        logger,
        {
          local: deps.localRunner,
          remote: deps.remote,
          child: deps.localRunnerChild,
        },
        deps.whileFenced &&
          ((request) =>
            deps.whileFenced!({ ...agent, status: "archiving" }, request))
      ).catch((err) => {
        if (err instanceof LifecycleSuperseded) throw err;
        logger.warn(
          { err, agentId: id },
          "Stop hook failed during delete; continuing"
        );
      });
      deps.beginStopStream(id);
      await runtime.stop(id, true);
      await deps.settleStream(id);
      // The state directory holds the launch file with the MCP token; the
      // stream is already in the database.
      if (managedCheckout(agent)) await runtime.clearRemoteState?.(id);
      else await runtime.discard(id);
      stopped = true;
    } catch (err) {
      if (err instanceof LifecycleSuperseded) return [];
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
