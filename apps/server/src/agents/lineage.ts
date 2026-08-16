/**
 * Delegation lineage: who launched whom.
 *
 * `agents.parent_agent_id` already records the launcher of every agent spawned
 * via dispatch_launch_agent / dispatch_launch_persona, but nothing surfaced it,
 * so an orchestrator saw a flat list of agents and a message that carried only a
 * sender name. A message from a grandchild was indistinguishable from a message
 * from a direct child until someone said so out of band.
 *
 * These helpers turn that column into the two things callers actually need: the
 * ancestor chain of an agent, and the relationship between two agents.
 */

/** Bounds chain walking so a corrupted parent link can never produce huge output. */
const MAX_LINEAGE_DEPTH = 20;

export type LineageAgent = {
  id: string;
  name: string;
  parentAgentId?: string | null;
};

export type LineageNode = { id: string; name: string };

/**
 * How another agent sits relative to a viewer in the delegation tree.
 * "sibling" means both were launched by the same agent; "unrelated" means no
 * ancestor path connects them (including two independently rooted agents).
 */
export type AgentRelation =
  | "parent"
  | "child"
  | "ancestor"
  | "descendant"
  | "sibling"
  | "unrelated";

function indexById<T extends LineageAgent>(agents: T[]): Map<string, T> {
  const byId = new Map<string, T>();
  for (const agent of agents) byId.set(agent.id, agent);
  return byId;
}

/**
 * The ancestors of `agentId`, nearest first: [parent, grandparent, ...root].
 *
 * Ancestors missing from `agents` (archived, or filtered out of the caller's
 * visible set) terminate the walk — a chain is only ever reported as far as it
 * can be resolved, never with holes. A cycle terminates it too.
 */
export function ancestorChain(
  agents: LineageAgent[],
  agentId: string
): LineageNode[] {
  const byId = indexById(agents);
  const chain: LineageNode[] = [];
  const seen = new Set<string>([agentId]);

  let current = byId.get(agentId)?.parentAgentId ?? null;
  while (current && !seen.has(current) && chain.length < MAX_LINEAGE_DEPTH) {
    seen.add(current);
    const parent = byId.get(current);
    if (!parent) break;
    chain.push({ id: parent.id, name: parent.name });
    current = parent.parentAgentId ?? null;
  }
  return chain;
}

/**
 * Where `otherId` sits relative to `viewerId`. Ancestry is checked before
 * siblinghood so a parent is never also reported as a sibling.
 */
export function relationTo(
  agents: LineageAgent[],
  viewerId: string,
  otherId: string
): AgentRelation {
  const byId = indexById(agents);
  const viewer = byId.get(viewerId);
  const other = byId.get(otherId);
  if (!viewer || !other) return "unrelated";

  if (other.parentAgentId === viewerId) return "child";
  if (viewer.parentAgentId === otherId) return "parent";

  if (ancestorChain(agents, otherId).some((a) => a.id === viewerId)) {
    return "descendant";
  }
  if (ancestorChain(agents, viewerId).some((a) => a.id === otherId)) {
    return "ancestor";
  }

  const viewerParent = viewer.parentAgentId ?? null;
  if (viewerParent && viewerParent === (other.parentAgentId ?? null)) {
    return "sibling";
  }
  return "unrelated";
}

/**
 * The delegation chain of a message: sender first, then each ancestor up to and
 * including the recipient when the recipient is one of them. When the recipient
 * is not an ancestor, the chain still walks to the sender's root so the
 * recipient can see where in the tree the sender actually lives.
 *
 * The chain is resolved from the full agent set rather than the sender's
 * addressable set: it describes the sender's own provenance to the one agent
 * being messaged, which is exactly the information the recipient was missing.
 */
export function delegationChain(
  agents: LineageAgent[],
  senderId: string,
  recipientId: string
): LineageNode[] {
  const byId = indexById(agents);
  const sender = byId.get(senderId);
  const chain: LineageNode[] = sender
    ? [{ id: sender.id, name: sender.name }]
    : [];

  for (const ancestor of ancestorChain(agents, senderId)) {
    chain.push(ancestor);
    if (ancestor.id === recipientId) break;
  }
  return chain;
}

/** Renders a chain as `A -> B -> C` for injection into a message prompt. */
export function formatDelegationChain(
  chain: LineageNode[],
  recipientId: string
): string {
  return chain
    .map(
      (node) =>
        `${node.name} (${node.id}${node.id === recipientId ? ", you" : ""})`
    )
    .join(" -> ");
}
