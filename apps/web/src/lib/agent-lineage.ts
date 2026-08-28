/**
 * The sidebar's lineage-to-card projection.
 *
 * Server-side, `parentAgentId` says which agent launched this one as a child.
 * The sidebar has to turn that tree into a two-level display: top-level cards,
 * each with a flat Sub Agents list. That projection is not a pure reading of
 * the lineage — it degrades deep trees and rescues orphans — so it lives here
 * rather than among the agent-type labels and validators.
 */

/**
 * The sidebar card an agent renders in, or its own id when it owns a card.
 *
 * Every agent with a parent renders as a row in the Sub Agents section of a
 * card — review agents from dispatch_launch_persona and plain children from
 * dispatch_launch_agent alike. Agents launched with `child: false` carry no
 * parent and own a card.
 *
 * The walk goes all the way to the root rather than stopping at the direct
 * parent. dispatch_launch_agent now caps new trees at one level of children,
 * but trees launched before that cap exist, and a sub agent row cannot host
 * rows of its own — so a grandchild resolved to its direct parent would render
 * nowhere at all. Resolving to the root flattens any depth into one list.
 *
 * A parent that is not in `agents` ends the walk. An archive cascades to
 * every child, so a missing parent is normally transient — but a child whose
 * parent is merely absent from this list becomes its own card rather than
 * disappearing along with it.
 */
export function cardIdForAgent(
  agent: { id: string; parentAgentId?: string | null },
  agentsById: Map<string, { id: string; parentAgentId?: string | null }>
): string {
  let current = agent;
  // Ordered, so a cycle can be sliced out of the walk rather than merely
  // detected. Bounded by the set size, so a corrupted parent link cannot spin
  // forever.
  const walked = [current.id];
  const seen = new Set<string>(walked);
  while (current.parentAgentId) {
    const parent = agentsById.get(current.parentAgentId);
    if (!parent) break;
    if (seen.has(parent.id)) {
      // A parent cycle has no root to walk to, and simply stopping here would
      // give each member a different answer — every one would resolve to some
      // other member, so none would own a card and the whole cycle would
      // vanish from the sidebar. Electing the lowest id among the cycle's own
      // members makes every member agree on one representative, which then
      // renders the rest as its sub agents. Agents that merely walk *into* a
      // cycle elect the same representative, since the slice excludes the
      // approach path.
      const cycle = walked.slice(walked.indexOf(parent.id));
      return cycle.reduce((lowest, id) => (id < lowest ? id : lowest));
    }
    walked.push(parent.id);
    seen.add(parent.id);
    current = parent;
  }
  return current.id;
}

/** Split an agent list into sidebar cards and the sub agent rows inside them. */
export function partitionAgentsByLineage<
  T extends { id: string; parentAgentId?: string | null },
>(agents: T[]): { topLevel: T[]; subAgentsByCardId: Map<string, T[]> } {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const topLevel: T[] = [];
  const subAgentsByCardId = new Map<string, T[]>();
  for (const agent of agents) {
    const cardId = cardIdForAgent(agent, agentsById);
    if (cardId === agent.id) {
      topLevel.push(agent);
      continue;
    }
    const siblings = subAgentsByCardId.get(cardId);
    if (siblings) siblings.push(agent);
    else subAgentsByCardId.set(cardId, [agent]);
  }
  return { topLevel, subAgentsByCardId };
}

/**
 * Every agent that would go with `rootId` when it is archived: its direct
 * children by `parentAgentId`, and theirs, to any depth.
 *
 * Mirrors the server cascade, which walks `parent_agent_id` and nothing else —
 * an agent launched with `child: false` has no parent link and is deliberately
 * left out, even though the same agent launched it.
 */
export function descendantAgents<
  T extends { id: string; parentAgentId?: string | null },
>(rootId: string, agents: T[]): T[] {
  const childrenByParent = new Map<string, T[]>();
  for (const agent of agents) {
    const parentId = agent.parentAgentId;
    if (!parentId) continue;
    const siblings = childrenByParent.get(parentId);
    if (siblings) siblings.push(agent);
    else childrenByParent.set(parentId, [agent]);
  }

  const collected: T[] = [];
  // Bounded by the set size: a corrupted parent link can form a cycle, and
  // without `seen` the walk would never terminate.
  const seen = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const currentId = queue.shift() as string;
    for (const child of childrenByParent.get(currentId) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      collected.push(child);
      queue.push(child.id);
    }
  }
  return collected;
}
