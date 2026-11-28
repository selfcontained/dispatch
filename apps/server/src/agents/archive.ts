import { enrolledRunnerId, controllerPlacement } from "../runners/placement.js";
import type { AgentArchivePreview } from "@dispatch/shared";
import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import {
  archiveRunner,
  withRepositorySource,
  type ArchiveCheckoutAgent,
} from "./archive-checkout.js";
import {
  archiveExecutor,
  archiveFailure,
  cascadeMode,
  finishArchiveCheckout,
  type ArchiveCheckoutHooks,
  type ArchiveOutcome,
} from "./archive-policy.js";
import type { RunnerComposition } from "../runners/directory.js";
import {
  RunnerCallError,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import type { RemoteRunnerService } from "./remote/service.js";
import { resolveArchiveHooks, runLifecycleHook } from "./lifecycle-hooks.js";
import {
  AgentError,
  CheckoutStatusUnavailable,
  LifecycleSuperseded,
} from "./errors.js";
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

/** A borrower must never run a repository's destructive cleanup in its owner's checkout. */
async function skipArchiveHook(
  pool: Pool,
  agent: AgentRecord
): Promise<boolean> {
  if (agent.worktreePath) return false;
  const { rows } = await pool.query<{ borrowed: boolean }>(
    `SELECT EXISTS (
      SELECT 1 FROM agents a WHERE a.id = $1 AND (
        (a.runner_worktree_owner IS NOT NULL AND a.runner_worktree_owner <> a.id)
        OR (a.worktree_path IS NULL AND EXISTS (
          SELECT 1 FROM agents owner WHERE owner.id <> a.id
          AND owner.worktree_path = a.cwd AND (owner.deleted_at IS NULL OR owner.runner_cleanup_pending)
        ))
      )
    ) AS borrowed`,
    [agent.id]
  );
  return rows[0]?.borrowed === true;
}

/** Read the effects of the target and its cascade without running a hook. */
export async function previewArchive(
  deps: Pick<
    ArchiveDeps,
    "pool" | "getRequiredAgent" | "remote" | "localRunnerChild"
  >,
  id: string,
  readStatus: (
    agent: AgentRecord
  ) => Promise<NonNullable<AgentArchivePreview["worktreeStatus"]>>
): Promise<AgentArchivePreview> {
  const { pool, getRequiredAgent } = deps;
  const target = await getRequiredAgent(id);
  const cleanupDescriptions = new Set<string>();
  const seen = new Set([id]);
  const pending = [target];
  for (const agent of pending) {
    if (!(await skipArchiveHook(pool, agent)))
      for await (const { hook } of resolveArchiveHooks(agent, {
        remote: deps.remote,
        child: deps.localRunnerChild,
      })) {
        if (hook.description) cleanupDescriptions.add(hook.description);
      }
    for (const childId of await getChildAgentIds(pool, agent.id)) {
      if (seen.has(childId)) continue;
      seen.add(childId);
      pending.push(await getRequiredAgent(childId));
    }
  }
  let status = null;
  let unreadable = false;
  if (target.worktreePath) {
    try {
      status = await readStatus(target);
    } catch (error) {
      if (!(error instanceof CheckoutStatusUnavailable)) throw error;
      unreadable = true;
    }
  }
  return {
    ...(unreadable && { worktreeStatusUnreadable: true }),
    worktreeStatus: status && {
      hasWorktree: status.hasWorktree,
      hasUnmergedCommits: status.hasUnmergedCommits,
      hasUncommittedChanges: status.hasUncommittedChanges,
      worktreePath: status.worktreePath,
      branchName: status.branchName,
      changedFiles: status.changedFiles,
      uncommittedFiles: status.uncommittedFiles,
    },
    subAgentCount: pending.length - 1,
    cleanupDescriptions: [...cleanupDescriptions],
  };
}

/** The agent's runner, with what the composition gives it for archives. */
export type ArchiveRunner = Runner &
  Pick<RunnerComposition, "archive" | "cleanupBudgetMs">;

/**
 * Finish an agent's checkout on its runner through the one archive
 * sequence. The runner's archive policy decides the co-owner rule, the
 * force skip and what a failure means; its cleanup budget, when the
 * composition gives one (main's 60 s on this machine), bounds the whole
 * cleanup: co-owner read, observation, removal.
 */
export async function archiveCheckout(
  pool: Pool,
  logger: FastifyBaseLogger,
  agent: ArchiveCheckoutAgent,
  mode: WorktreeCleanupMode,
  /** The agent's host stopped. */
  stopped: boolean,
  hooks: ArchiveCheckoutHooks | undefined,
  runner: ArchiveRunner
): Promise<ArchiveOutcome> {
  const policy = runner.archive;
  if (policy.coOwner === "recorded" && !agent.worktreePath)
    return { kind: "kept", reason: "notManaged" };
  const executor = archiveExecutor(pool, agent, runner, stopped);
  const budget = runner.cleanupBudgetMs;
  if (budget === undefined)
    return finishArchiveCheckout(pool, logger, agent, mode, executor, hooks);

  // A late observation cannot authorize a release after the budget expired.
  const deadline = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      finishArchiveCheckout(
        pool,
        logger,
        agent,
        mode,
        executor,
        hooks,
        mode === "auto" ? deadline.signal : undefined
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(
            `Worktree cleanup timed out after ${budget}ms`
          );
          deadline.abort(error);
          reject(error);
        }, budget);
      }),
    ]);
  } catch (err) {
    if (mode === "auto" && deadline.signal.aborted)
      await pool.query(
        "UPDATE agents SET archive_cleanup_mode = 'keep', archive_checkout_state = NULL WHERE id = $1",
        [agent.id]
      );
    const failure = archiveFailure(policy);
    logger.warn(
      { err, agentId: agent.id, worktreePath: agent.worktreePath },
      failure.message
    );
    return failure.outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  agent = await withRepositorySource(deps.pool, agent);
  const hooks = { durations, onCleanupStart };
  // Release on the runner that owns the binding. An offline release stays pending.
  const outcome = await archiveCheckout(
    deps.pool,
    deps.logger,
    agent,
    mode,
    stopped,
    hooks,
    archiveRunner(
      { child: deps.localRunnerChild, remote: deps.remote },
      agent,
      agent.placement
    )
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

  if (checkoutState !== null) {
    const agent = await deps.getAgent(id);
    if (
      agent &&
      archiveRunner({ remote: deps.remote }, agent, agent.placement).archive
        .coOwner === "observed"
    )
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
      if (enrolledRunnerId(agent.placement ?? controllerPlacement))
        await runtime.clearRemoteState?.(id);
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

    if (!(await skipArchiveHook(pool, agent)))
      await runLifecycleHook(
        "archive",
        agent,
        logger,
        {
          remote: deps.remote,
          child: deps.localRunnerChild,
          recordArchivePhase: (phase) => deps.setArchivePhase(id, phase),
        },
        deps.whileFenced && ((request) => deps.whileFenced!(agent, request))
      );

    const publishPhase = async (phase: ArchivePhase) => {
      await deps.setArchivePhase(id, phase);
      const updated = await deps.getAgent(id);
      if (updated) callbacks.onPhaseChange(updated);
    };

    // Stop dependents before removing this checkout. Children and reviewers
    // can both share it through their working directories.
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
    if (error instanceof LifecycleSuperseded) return;
    if (error instanceof RunnerCallError && error.code === "unavailable")
      return;
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
  if (
    agent.status !== "stopped" ||
    enrolledRunnerId(agent.placement ?? controllerPlacement)
  ) {
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
      if (enrolledRunnerId(agent.placement ?? controllerPlacement))
        await runtime.clearRemoteState?.(id);
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

  try {
    if (!(await skipArchiveHook(pool, agent)))
      await runLifecycleHook(
        "archive",
        agent,
        logger,
        {
          remote: deps.remote,
          child: deps.localRunnerChild,
          recordArchivePhase: (phase) => deps.setArchivePhase(id, phase),
        },
        deps.whileFenced &&
          ((request) =>
            deps.whileFenced!({ ...agent, status: "archiving" }, request))
      );
  } catch (error) {
    if (
      error instanceof LifecycleSuperseded ||
      (error instanceof RunnerCallError && error.code === "unavailable")
    )
      return [];
    await deps.setAgentStatus(
      id,
      "error",
      error instanceof Error ? error.message : "Archive hook failed"
    );
    await deps.setArchivePhase(id, null);
    throw error;
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
