import type { Block } from "@dispatch/shared";

import type { Queryable } from "./store.js";

/** Properties that name one agent wherever they appear on a block. */
const AGENT_ID_KEYS = new Set([
  "agentId",
  "toAgentId",
  "launchedByAgentId",
  "authorAgentId",
]);

function collect(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, into);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") {
      if (AGENT_ID_KEYS.has(key)) into.add(child);
    } else if (
      (key === "mentions" || key === "recipients") &&
      Array.isArray(child)
    ) {
      for (const id of child) if (typeof id === "string") into.add(id);
    } else if (key !== "turn") {
      // A turn's steps are the engine's, never an agent's name.
      collect(child, into);
    }
  }
}

/**
 * Every agent a page of blocks names: authors, recipients, launchers,
 * mentions, reactors, repliers, delivery rows, and the authors a block's
 * state records (a finding resolved by an agent).
 */
export function agentIdsIn(blocks: readonly Block[]): string[] {
  const ids = new Set<string>();
  for (const block of blocks) collect(block, ids);
  return [...ids];
}

/**
 * The names of the agents a page of blocks mentions, archived or not.
 * Blocks outlive the agents that wrote them; the agents list leaves an
 * archived agent out, so the page carries the names itself.
 */
export async function agentNamesFor(
  db: Queryable,
  blocks: readonly Block[]
): Promise<Record<string, string>> {
  const ids = agentIdsIn(blocks);
  if (ids.length === 0) return {};
  // Deliberately ignores deleted_at: an archived agent keeps its name.
  const result = await db.query<{ id: string; name: string }>(
    "SELECT id, name FROM agents WHERE id = ANY($1::text[])",
    [ids]
  );
  const names: Record<string, string> = {};
  for (const row of result.rows) names[row.id] = row.name;
  return names;
}
