import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import { cleanupGitWorktree } from "../shared/git/worktree.js";
import { runCommand, type CommandRunner } from "../shared/lib/run-command.js";
import {
  getUncommittedChanges,
  getUnmergedChanges,
} from "../shared/git/worktree-status.js";
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
  diffStatsRefresher: { clear(agentId: string): void } | null;
  getAgent: (id: string) => Promise<AgentRecord | null>;
  getRequiredAgent: (id: string) => Promise<AgentRecord>;
  harvestAgentTokens: (agent: AgentRecord) => Promise<void>;
  /** Stop a protocol-driven harness (dsh) that lives outside the tmux pane. */
  stopHarness?: (agent: AgentRecord) => Promise<void>;
  setAgentStatus: (
    id: string,
    status: AgentStatus,
    lastError: string | null,
    tmuxSession?: string
  ) => Promise<void>;
  setArchivePhase: (id: string, phase: ArchivePhase) => Promise<void>;
};

/**
 * Children go with the parent, worktrees included. The parent's confirmation is
 * the one answer for the whole cascade, so children are never checked or asked
 * about separately.
 */
const CASCADED_CHILD_CLEANUP: WorktreeCleanupMode = "force";

/**
 * Every true child of this agent. `parent_agent_id` only — never
 * `launched_by_agent_id`, which is also set for `child: false` launches that
 * asked to be independent. An agent already `archiving` belongs to its own
 * archive, which is cascading to that subtree itself.
 */
async function getChildAgentIds(
  pool: Pool,
  parentAgentId: string
): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    `SELECT id
     FROM agents
     WHERE parent_agent_id = $1
       AND deleted_at IS NULL
       AND status != 'archiving'`,
    [parentAgentId]
  );
  return result.rows.map((row) => row.id);
}

/**
 * git blocks indefinitely on a held index lock, and the cascade is sequential —
 * one hang would strand every sibling behind it.
 */
const WORKTREE_CLEANUP_TIMEOUT_MS = 60_000;

/** Rejects if `work` outruns `ms`, always clearing its own timer. */
async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * `force` always removes, `keep` never does, `auto` removes only a worktree
 * holding nothing. Never throws — an unremovable worktree is left on disk.
 */
async function cleanupAgentWorktree(
  pool: Pool,
  logger: FastifyBaseLogger,
  agent: AgentRecord,
  cleanupWorktree: WorktreeCleanupMode,
  durations: Record<string, number>,
  onCleanupStart?: () => Promise<void>
): Promise<void> {
  if (!agent.worktreePath) return;
  const id = agent.id;
  const worktreePath = agent.worktreePath;

  const run = async () => {
    // No uniqueness constraint on either column, so two live rows can name one
    // worktree; removing it would take the other agent's work.
    const coOwner = await pool.query<{ id: string }>(
      `SELECT id
       FROM agents
       WHERE deleted_at IS NULL
         AND id <> $1
         AND (worktree_path = $2 OR ($3::text IS NOT NULL AND worktree_branch = $3))
       LIMIT 1`,
      [id, worktreePath, agent.worktreeBranch]
    );
    if ((coOwner.rowCount ?? 0) > 0) {
      logger.warn(
        {
          agentId: id,
          worktreePath,
          worktreeBranch: agent.worktreeBranch,
          sharedWithAgentId: coOwner.rows[0]?.id,
        },
        "Another live agent references this worktree; leaving it on disk."
      );
      return;
    }

    const tCheck = Date.now();
    let shouldCleanup = cleanupWorktree === "force";
    let preserveReason: string | undefined;

    if (!shouldCleanup && cleanupWorktree === "auto") {
      const [unmerged, uncommitted] = await Promise.all([
        getUnmergedChanges(worktreePath),
        getUncommittedChanges(worktreePath),
      ]);
      const hasChanges =
        unmerged.hasUnmergedCommits || uncommitted.hasUncommittedChanges;
      shouldCleanup = !hasChanges;
      if (hasChanges) {
        const reasons: string[] = [];
        if (unmerged.hasUnmergedCommits)
          reasons.push(`${unmerged.changedFiles.length} unmerged file(s)`);
        if (uncommitted.hasUncommittedChanges)
          reasons.push(
            `${uncommitted.uncommittedFiles.length} uncommitted file(s)`
          );
        preserveReason = reasons.join(", ");
      }
    } else if (!shouldCleanup && cleanupWorktree === "keep") {
      preserveReason = "user chose keep";
    }
    durations.outstandingChangesCheck = Date.now() - tCheck;

    if (shouldCleanup) {
      await onCleanupStart?.();

      const tCleanup = Date.now();
      const dispatchOwnsBranch =
        !!agent.worktreeBranch &&
        (!agent.baseBranch || agent.worktreeBranch !== agent.baseBranch);
      const boundedGit: CommandRunner = (command, args, options) =>
        runCommand(command, args, {
          ...options,
          timeoutMs: options?.timeoutMs ?? WORKTREE_CLEANUP_TIMEOUT_MS,
        });
      await cleanupGitWorktree(
        {
          cwd: worktreePath,
          deleteBranch: dispatchOwnsBranch,
          force: true,
          originalBranch: agent.worktreeBranch,
        },
        boundedGit
      );
      durations.worktreeCleanup = Date.now() - tCleanup;
      logger.info(
        { agentId: id, worktreePath: worktreePath },
        "Cleaned up agent worktree."
      );
    } else {
      logger.info(
        {
          agentId: id,
          worktreePath: worktreePath,
          cleanupWorktree,
          preserveReason,
        },
        `Preserved agent worktree: ${preserveReason}.`
      );
    }
  };

  // Cleanup never fails the archive around it — siblings still have to run.
  try {
    await withTimeout(
      run(),
      WORKTREE_CLEANUP_TIMEOUT_MS,
      `Worktree cleanup timed out after ${WORKTREE_CLEANUP_TIMEOUT_MS}ms`
    );
  } catch (error) {
    logger.warn(
      { err: error, agentId: id, worktreePath },
      "Worktree cleanup failed; leaving on disk."
    );
  }
}

export async function beginArchive(
  deps: ArchiveDeps,
  id: string,
  cleanupWorktree: WorktreeCleanupMode = "auto"
): Promise<AgentRecord> {
  const { pool } = deps;

  const result = await pool.query(
    `UPDATE agents
     SET status = 'archiving', archive_phase = 'stopping', archive_cleanup_mode = $2, updated_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL AND status != 'archiving'
     RETURNING id`,
    [id, cleanupWorktree]
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

    // Phase: stopping — tear down session without changing agent status
    const t = Date.now();
    try {
      await runLifecycleHook("stop", agent, logger).catch((err) =>
        logger.warn(
          { err, agentId: id },
          "Stop hook failed during archive; continuing"
        )
      );
      await deps.stopHarness?.(agent);
      if (agent.tmuxSession && (await runtime.hasSession(agent.tmuxSession))) {
        await runtime.stopSession(agent.tmuxSession, true);
      }
      deps
        .harvestAgentTokens(agent)
        .catch((err) =>
          logger.warn(
            { err, agentId: id },
            "Token harvest failed during archive"
          )
        );
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

    // Phase: worktree-check
    await publishPhase("worktree-check");

    await cleanupAgentWorktree(
      pool,
      logger,
      agent,
      cleanupWorktree,
      durations,
      () => publishPhase("worktree-cleanup")
    );

    // Phase: finalizing
    await publishPhase("finalizing");

    const tDb = Date.now();
    await pool.query(
      `UPDATE agent_surfaces SET lifecycle = 'frozen', revision = revision + 1, updated_at = NOW()
       WHERE agent_id = $1 AND deleted_at IS NULL AND lifecycle = 'active'`,
      [id]
    );
    await pool.query(
      `UPDATE agent_surface_interactions SET status = 'orphaned', resolved_at = NOW()
       WHERE agent_id = $1 AND status IN ('queued', 'notified', 'claimed')`,
      [id]
    );
    await pool
      .query(
        `INSERT INTO agent_events (agent_id, event_type, message, metadata, agent_type, agent_name, project_dir)
         SELECT $1, 'idle', 'Agent deleted.', '{"source":"system"}'::jsonb, type, name, COALESCE(git_context->>'repoRoot', cwd)
         FROM agents WHERE id = $1`,
        [id]
      )
      .catch((err) => logger.warn({ err }, "Failed to insert delete event"));

    await pool.query(
      "UPDATE agents SET deleted_at = NOW(), archive_phase = NULL, archive_cleanup_mode = NULL, updated_at = NOW() WHERE id = $1",
      [id]
    );
    durations.db = Date.now() - tDb;
    diffStatsRefresher?.clear(id);

    // Already deleted: the outer catch would report an error and never publish
    // the deletion.
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
  const sessionExists = agent.tmuxSession
    ? await runtime.hasSession(agent.tmuxSession)
    : false;

  // Claim before any teardown — an agent's own archive and an ancestor's
  // cascade can reach it at once. Same CAS `beginArchive` takes.
  const claimed = await pool.query(
    `UPDATE agents
     SET status = 'archiving', archive_phase = 'stopping', updated_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL AND status != 'archiving'
     RETURNING id`,
    [id]
  );
  if (claimed.rowCount === 0) {
    logger.info(
      { agentId: id },
      "Agent is already being archived or deleted; skipping cascade."
    );
    return [];
  }

  if (agent.status !== "stopped") {
    const t = Date.now();
    // Not stopAgent: it writes `stopping`/`stopped`, releasing the claim above
    // and letting a fresh archive take this agent mid-teardown.
    try {
      await runLifecycleHook("stop", agent, logger).catch((err) =>
        logger.warn(
          { err, agentId: id },
          "Stop hook failed during delete; continuing"
        )
      );
      await deps.stopHarness?.(agent);
      if (agent.tmuxSession && sessionExists) {
        await runtime.stopSession(agent.tmuxSession, true);
      }
      deps
        .harvestAgentTokens(agent)
        .catch((err) =>
          logger.warn(
            { err, agentId: id },
            "Token harvest failed during delete"
          )
        );
    } catch (err) {
      logger.warn(
        { err, agentId: id },
        "Stop during delete failed; continuing with deletion"
      );
    }
    durations.stop = Date.now() - t;
  }

  const tDb = Date.now();
  await pool
    .query(
      `INSERT INTO agent_events (agent_id, event_type, message, metadata, agent_type, agent_name, project_dir)
       SELECT $1, 'idle', 'Agent deleted.', '{"source":"system"}'::jsonb, type, name, COALESCE(git_context->>'repoRoot', cwd)
       FROM agents WHERE id = $1`,
      [id]
    )
    .catch((err) => logger.warn({ err }, "Failed to insert delete event"));

  await pool.query(
    `UPDATE agent_surfaces SET lifecycle = 'frozen', revision = revision + 1, updated_at = NOW()
     WHERE agent_id = $1 AND deleted_at IS NULL AND lifecycle = 'active'`,
    [id]
  );
  await pool.query(
    `UPDATE agent_surface_interactions SET status = 'orphaned', resolved_at = NOW()
     WHERE agent_id = $1 AND status IN ('queued', 'notified', 'claimed')`,
    [id]
  );
  // Keeping it would leave a worktree no agent record can reach.
  await cleanupAgentWorktree(
    pool,
    logger,
    agent,
    CASCADED_CHILD_CLEANUP,
    durations
  );

  await pool.query(
    `UPDATE agents
     SET deleted_at = NOW(), archive_phase = NULL, archive_cleanup_mode = NULL, updated_at = NOW()
     WHERE id = $1`,
    [id]
  );
  durations.db = Date.now() - tDb;
  diffStatsRefresher?.clear(id);

  // This row is soft-deleted above, so the query cannot return an ancestor and
  // a corrupted parent link cannot loop. Nothing below may throw: the id has to
  // reach the caller or the UI keeps rendering a deleted agent.
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

  return deletedIds;
}
