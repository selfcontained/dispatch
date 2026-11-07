import type { QueryResult, QueryResultRow } from "pg";

type Queryable = {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<R>>;
};

/** How far up or down a lineage the queries walk; a cycle cannot recurse forever. */
const MAX_DEPTH = 32;

/**
 * The root of an agent's lineage: itself when it has no parent, otherwise
 * the top of its `parent_agent_id` chain. Lineage groups agents and preserves
 * legacy access; each agent owns its new chat stream. An unknown agent is its own root, so a
 * caller can use the result as a stream id without a second lookup.
 */
export async function rootAgentId(
  db: Queryable,
  agentId: string
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `WITH RECURSIVE up AS (
       SELECT id, parent_agent_id, 0 AS depth FROM agents WHERE id = $1
       UNION ALL
       SELECT a.id, a.parent_agent_id, up.depth + 1
         FROM agents a
         JOIN up ON a.id = up.parent_agent_id
        WHERE up.depth < $2
     )
     SELECT id FROM up ORDER BY depth DESC LIMIT 1`,
    [agentId, MAX_DEPTH]
  );
  return result.rows[0]?.id ?? agentId;
}

/** An agent and every descendant, root first. */
export async function agentTree(
  db: Queryable,
  rootId: string
): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `WITH RECURSIVE down AS (
       SELECT id, 0 AS depth FROM agents WHERE id = $1
       UNION ALL
       SELECT a.id, down.depth + 1
         FROM agents a
         JOIN down ON a.parent_agent_id = down.id
        WHERE down.depth < $2
     )
     SELECT id FROM down ORDER BY depth, id`,
    [rootId, MAX_DEPTH]
  );
  const ids = result.rows.map((row) => row.id);
  return ids.length > 0 ? ids : [rootId];
}

/** The parent of an agent, or null. */
export async function parentAgentId(
  db: Queryable,
  agentId: string
): Promise<string | null> {
  const result = await db.query<{ parent_agent_id: string | null }>(
    `SELECT parent_agent_id FROM agents WHERE id = $1`,
    [agentId]
  );
  return result.rows[0]?.parent_agent_id ?? null;
}

/** Review requests belong to their launcher even when display lineage is flat.
 * Ordinary agents retain their existing parent ownership.
 */
export async function requestOwnerAgentId(
  db: Queryable,
  agentId: string
): Promise<string | null> {
  const result = await db.query<{ owner_id: string | null }>(
    `SELECT CASE WHEN role = 'review' THEN COALESCE(launched_by_agent_id, parent_agent_id)
      ELSE parent_agent_id END AS owner_id FROM agents WHERE id = $1`,
    [agentId]
  );
  return result.rows[0]?.owner_id ?? null;
}
