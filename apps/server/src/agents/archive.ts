import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import { cleanupGitWorktree } from "../shared/git/worktree.js";
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
  stopAgent: (id: string, input: { force?: boolean }) => Promise<AgentRecord>;
  harvestAgentTokens: (agent: AgentRecord) => Promise<void>;
  setAgentStatus: (
    id: string,
    status: AgentStatus,
    lastError: string | null,
    tmuxSession?: string
  ) => Promise<void>;
  setArchivePhase: (id: string, phase: ArchivePhase) => Promise<void>;
};

async function getReviewChildAgentIds(
  pool: Pool,
  parentAgentId: string
): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    `SELECT id
     FROM agents
     WHERE parent_agent_id = $1
       AND role = 'review'
       AND deleted_at IS NULL`,
    [parentAgentId]
  );
  return result.rows.map((row) => row.id);
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

    if (agent.worktreePath) {
      try {
        const tCheck = Date.now();
        let shouldCleanup = cleanupWorktree === "force";
        let preserveReason: string | undefined;

        if (!shouldCleanup && cleanupWorktree === "auto") {
          const [unmerged, uncommitted] = await Promise.all([
            getUnmergedChanges(agent.worktreePath),
            getUncommittedChanges(agent.worktreePath),
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
          // Phase: worktree-cleanup
          await publishPhase("worktree-cleanup");

          const tCleanup = Date.now();
          const dispatchOwnsBranch =
            !!agent.worktreeBranch &&
            (!agent.baseBranch || agent.worktreeBranch !== agent.baseBranch);
          await cleanupGitWorktree({
            cwd: agent.worktreePath,
            deleteBranch: dispatchOwnsBranch,
            force: true,
            originalBranch: agent.worktreeBranch,
          });
          durations.worktreeCleanup = Date.now() - tCleanup;
          logger.info(
            { agentId: id, worktreePath: agent.worktreePath },
            "Cleaned up agent worktree."
          );
        } else {
          logger.info(
            {
              agentId: id,
              worktreePath: agent.worktreePath,
              cleanupWorktree,
              preserveReason,
            },
            `Preserved agent worktree: ${preserveReason}.`
          );
        }
      } catch (error) {
        logger.warn(
          { err: error, agentId: id },
          "Worktree cleanup failed; leaving on disk."
        );
      }
    }

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

    // Cascade: archive review child agents only (not regular launched agents)
    const tCascade = Date.now();
    const reviewChildIds = await getReviewChildAgentIds(pool, id);
    for (const childId of reviewChildIds) {
      try {
        await deleteAgentDirect(deps, childId, true, cleanupWorktree);
      } catch (err) {
        logger.warn(
          { err, childId, parentId: id },
          "Failed to cascade-delete child agent"
        );
      }
    }
    if (reviewChildIds.length > 0) {
      durations.cascadeChildren = Date.now() - tCascade;
    }

    durations.total = Date.now() - deleteStart;
    const parts = Object.entries(durations)
      .map(([k, v]) => `${k}=${v}ms`)
      .join(", ");
    logger.info({ agentId: id, durations }, `Archive durations: ${parts}`);

    const deletedIds = [id, ...reviewChildIds];
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

export async function deleteAgentDirect(
  deps: ArchiveDeps,
  id: string,
  force = false,
  cleanupWorktree: WorktreeCleanupMode = "auto"
): Promise<void> {
  const { pool, logger, runtime, diffStatsRefresher } = deps;
  const deleteStart = Date.now();
  const durations: Record<string, number> = {};
  const agent = await deps.getRequiredAgent(id);
  const sessionExists = agent.tmuxSession
    ? await runtime.hasSession(agent.tmuxSession)
    : false;

  if (agent.status === "running" && sessionExists && !force) {
    throw new AgentError(
      "Agent is running. Stop it first or use force delete.",
      409
    );
  }

  if (agent.status !== "stopped") {
    const t = Date.now();
    try {
      await deps.stopAgent(id, { force: true });
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
  await pool.query(
    "UPDATE agents SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1",
    [id]
  );
  durations.db = Date.now() - tDb;
  diffStatsRefresher?.clear(id);

  // Cascade to review children only (not regular launched agents)
  const reviewChildIds = await getReviewChildAgentIds(pool, id);
  for (const childId of reviewChildIds) {
    try {
      await deleteAgentDirect(deps, childId, true, cleanupWorktree);
    } catch (err) {
      logger.warn(
        { err, childId, parentId: id },
        "Failed to cascade-delete child agent"
      );
    }
  }

  durations.total = Date.now() - deleteStart;
  const parts = Object.entries(durations)
    .map(([k, v]) => `${k}=${v}ms`)
    .join(", ");
  logger.info({ agentId: id, durations }, `Archive durations: ${parts}`);
}
