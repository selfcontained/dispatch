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
  harvestAgentTokens: (agent: AgentRecord) => Promise<void>;
  setAgentStatus: (
    id: string,
    status: AgentStatus,
    lastError: string | null,
    tmuxSession?: string
  ) => Promise<void>;
  setArchivePhase: (id: string, phase: ArchivePhase) => Promise<void>;
};

/**
 * The agents an archive cascades to: every agent launched as a true child of
 * this one, review or not.
 *
 * The filter is `parent_agent_id` and only `parent_agent_id`. The sibling
 * column `launched_by_agent_id` is deliberately excluded: it is populated for
 * every agent-initiated launch, including `child: false` ones that were
 * explicitly asked to be independent top-level agents. Widening this to
 * `parent_agent_id = $1 OR launched_by_agent_id = $1` would sweep those
 * independent agents into the parent's archive, which is exactly what
 * `child: false` exists to prevent.
 *
 * A child already in `archiving` is skipped: its own archive owns it and is
 * cascading to its descendants itself, so taking it here would run the whole
 * teardown twice over one subtree.
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

    // Cascade: archive every true child (parent_agent_id), review or not.
    // deleteAgentDirect recurses, so the whole subtree goes with the parent
    // rather than being left behind as orphaned top-level agents.
    //
    // This agent's row is gone by now, so a failure here must not reach the
    // outer catch: that path reports an error instead of completing, and the
    // deleted agent would never be published as deleted.
    const tCascade = Date.now();
    const cascadedIds: string[] = [];
    try {
      const childIds = await getChildAgentIds(pool, id);
      for (const childId of childIds) {
        try {
          cascadedIds.push(
            ...(await deleteAgentDirect(deps, childId, true, cleanupWorktree))
          );
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
 * Deletes one agent and, recursively, every true child beneath it.
 *
 * Returns the ids actually deleted — this agent first, then its descendants in
 * the order they were removed. Callers publish `agent.deleted` for each, so a
 * grandchild that goes with the subtree has to appear here or the UI keeps
 * rendering a row for an agent the database no longer has.
 */
export async function deleteAgentDirect(
  deps: ArchiveDeps,
  id: string,
  force = false,
  cleanupWorktree: WorktreeCleanupMode = "auto"
): Promise<string[]> {
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

  // Claim the agent before any teardown. The same row can be reached twice —
  // by its own archive and by an ancestor's cascade — and everything below is
  // effectful: stop hooks fire, the session dies, events are written. The CAS
  // is the same one `beginArchive` takes, so the two paths contend for one
  // lock rather than each having their own. A claim left behind by a crash is
  // picked up by the archiving-status reconciler on the next start.
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
    // Tear the session down directly rather than through stopAgent: that path
    // writes `stopping` and then `stopped`, which would release the claim taken
    // above and let a fresh archive claim this agent mid-teardown. The row stays
    // `archiving` until the delete lands. Same reason executeArchive does it
    // this way for its own agent.
    try {
      await runLifecycleHook("stop", agent, logger).catch((err) =>
        logger.warn(
          { err, agentId: id },
          "Stop hook failed during delete; continuing"
        )
      );
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
  await pool.query(
    `UPDATE agents
     SET deleted_at = NOW(), archive_phase = NULL, archive_cleanup_mode = NULL, updated_at = NOW()
     WHERE id = $1`,
    [id]
  );
  durations.db = Date.now() - tDb;
  diffStatsRefresher?.clear(id);

  // Cascade to every true child (parent_agent_id), review or not. This agent's
  // row is already soft-deleted above, so the query cannot hand back an
  // ancestor and a corrupted parent link cannot make the recursion loop.
  //
  // `deletedIds` carries this agent from here on. Nothing below may throw past
  // this point: the row is gone, and a caller that never learns the id would
  // leave the UI rendering a row for an agent the database no longer has.
  const deletedIds = [id];
  try {
    const childIds = await getChildAgentIds(pool, id);
    for (const childId of childIds) {
      try {
        deletedIds.push(
          ...(await deleteAgentDirect(deps, childId, true, cleanupWorktree))
        );
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
