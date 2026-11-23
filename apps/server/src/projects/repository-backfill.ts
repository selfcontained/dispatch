import type { Pool, PoolClient } from "pg";
import { inferProjectRepository } from "../agents/remote/repository.js";

type Candidate = { id: string; repo_root: string };

async function mergeProjects(db: PoolClient, loser: string, winner: string) {
  const ids = [loser, winner];
  const columns = `
    FROM task_columns old JOIN task_columns kept ON kept.key = old.key
    WHERE old.project_id = $1 AND kept.project_id = $2`;
  for (const table of ["tasks", "task_agents"]) {
    await db.query(
      `UPDATE ${table} t SET column_id = kept.id ${columns} AND t.column_id = old.id`,
      ids
    );
  }
  await db.query(
    `DELETE FROM task_columns c USING task_columns kept
     WHERE c.project_id = $1 AND kept.project_id = $2 AND c.key = kept.key`,
    ids
  );
  await db.query(
    `WITH appended AS (
       SELECT id, row_number() OVER (ORDER BY position, id) AS relative_position
       FROM task_columns WHERE project_id = $1
     )
     UPDATE task_columns c SET project_id = $2, position =
       (SELECT coalesce(max(position), -1) FROM task_columns WHERE project_id = $2)
       + appended.relative_position
     FROM appended WHERE c.id = appended.id`,
    ids
  );

  await db.query(
    `INSERT INTO task_label_assignments (task_id, label_id)
     SELECT a.task_id, kept.id FROM task_label_assignments a
     JOIN task_labels old ON old.id = a.label_id
     JOIN task_labels kept ON lower(kept.name) = lower(old.name)
     WHERE old.project_id = $1 AND kept.project_id = $2
     ON CONFLICT DO NOTHING`,
    ids
  );
  await db.query(
    `DELETE FROM task_labels old USING task_labels kept
     WHERE old.project_id = $1 AND kept.project_id = $2
     AND lower(old.name) = lower(kept.name)`,
    ids
  );
  await db.query(
    "UPDATE task_labels SET project_id = $2 WHERE project_id = $1",
    ids
  );

  await db.query(
    `INSERT INTO task_watch_items (task_id, agent_id, source, item_id, board_watch_id, created_at)
     SELECT i.task_id, i.agent_id, i.source, i.item_id, kept.id, i.created_at
     FROM task_watch_items i
     JOIN task_board_watches old ON old.id = i.board_watch_id
     JOIN task_board_watches kept ON kept.agent_id = old.agent_id
     WHERE old.project_id = $1 AND kept.project_id = $2
     ON CONFLICT DO NOTHING`,
    ids
  );
  await db.query(
    `DELETE FROM task_board_watches old USING task_board_watches kept
     WHERE old.project_id = $1 AND kept.project_id = $2 AND old.agent_id = kept.agent_id`,
    ids
  );
  await db.query(
    "UPDATE task_board_watches SET project_id = $2 WHERE project_id = $1",
    ids
  );

  for (const table of ["agents", "templates", "tasks", "message_shares"]) {
    await db.query(
      `UPDATE ${table} SET project_id = $2 WHERE project_id = $1`,
      ids
    );
  }
  // Saved runner targets also carry the project ID in their encoded location.
  for (const table of ["templates", "jobs", "job_runs"]) {
    await db.query(
      `UPDATE ${table} SET location = jsonb_set(location, '{projectId}', to_jsonb($2::text))
       WHERE location->>'projectId' = $1`,
      ids
    );
  }

  await db.query(
    `UPDATE projects kept SET extra_roots =
       kept.extra_roots || array_remove(ARRAY[old.repo_root], NULL) || old.extra_roots
     FROM projects old WHERE old.id = $1 AND kept.id = $2`,
    ids
  );
  await db.query("DELETE FROM projects WHERE id = $1", [loser]);
}

async function recordRepository(
  pool: Pool,
  candidate: Candidate,
  repository: string
) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query(
      "SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'"
    );
    // Serialize the repository lookup with project inserts and other backfills.
    // Row locks also prevent new foreign-key references to a project being merged.
    await db.query("LOCK TABLE projects IN SHARE ROW EXCLUSIVE MODE");
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM projects
       WHERE (id = $1 AND repo_root = $2 AND repository IS NULL) OR repository = $3
       ORDER BY created_at, id FOR UPDATE`,
      [candidate.id, candidate.repo_root, repository]
    );
    if (!rows.some(({ id }) => id === candidate.id)) {
      await db.query("COMMIT");
      return false;
    }
    const [winner, loser] = rows;
    if (loser) await mergeProjects(db, loser.id, winner!.id);
    await db.query("UPDATE projects SET repository = $2 WHERE id = $1", [
      winner!.id,
      repository,
    ]);
    await db.query("COMMIT");
    return Boolean(loser);
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

/** Each unresolved folder gets one bounded Git config read per server start. */
export async function backfillProjectRepositories(
  pool: Pool,
  logError: (error: unknown) => void,
  onMerge: () => void = () => {}
) {
  try {
    const { rows } = await pool.query<Candidate>(
      `SELECT id, repo_root FROM projects WHERE repository IS NULL AND repo_root IS NOT NULL
       ORDER BY created_at, id`
    );
    for (const project of rows) {
      try {
        const repository = await inferProjectRepository(project.repo_root);
        if (repository && (await recordRepository(pool, project, repository)))
          onMerge();
      } catch (error) {
        logError(error);
      }
    }
  } catch (error) {
    logError(error);
  }
}
