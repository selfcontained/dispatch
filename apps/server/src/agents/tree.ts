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
 * the top of its `parent_agent_id` chain. The root's id is the stream every
 * agent in the tree posts into. An unknown agent is its own root, so a
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
