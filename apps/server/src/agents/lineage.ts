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
 *
 * Everything hangs off a `LineageIndex` built once per request. Listing agents
 * asks for a relation per returned agent and each relation inspects two ancestor
 * chains, so re-deriving the id map and re-walking the tree per call would make
 * the common path quadratic in the number of agents for no benefit — the tree is
 * identical for every question asked within one request.
 */

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

export type LineageIndex = {
  get(agentId: string): LineageAgent | undefined;
  /** Ancestors of `agentId`, nearest first: [parent, grandparent, ...root]. */
  ancestors(agentId: string): LineageNode[];
};

/**
 * Build the lineage view of an agent set. Pass every agent the server knows
 * about, not a filtered subset: an ancestor missing from the set terminates the
 * walk, which would silently report a grandchild as a child.
 */
export function createLineageIndex(agents: LineageAgent[]): LineageIndex {
  const byId = new Map<string, LineageAgent>();
  for (const agent of agents) byId.set(agent.id, agent);
  const chains = new Map<string, LineageNode[]>();

  function ancestors(agentId: string): LineageNode[] {
    const cached = chains.get(agentId);
    if (cached) return cached;

    // Walked iteratively rather than composed from the parent's cached chain:
    // under a parent cycle the parent's chain contains this agent, so composing
    // would splice an agent into its own ancestry.
    const chain: LineageNode[] = [];
    const seen = new Set<string>([agentId]);
    let current = byId.get(agentId)?.parentAgentId ?? null;
    while (current && !seen.has(current)) {
      seen.add(current);
      const parent = byId.get(current);
      // An unresolvable parent ends the chain rather than leaving a hole in it.
      if (!parent) break;
      chain.push({ id: parent.id, name: parent.name });
      current = parent.parentAgentId ?? null;
    }
    // `seen` bounds the walk at the size of the agent set, so a corrupted
    // parent link terminates without an arbitrary depth cap that would report a
    // legitimately deep descendant as unrelated.
    chains.set(agentId, chain);
    return chain;
  }

  return { get: (agentId) => byId.get(agentId), ancestors };
}

/** Ancestors of `agentId`, nearest first: [parent, grandparent, ...root]. */
export function ancestorChain(
  index: LineageIndex,
  agentId: string
): LineageNode[] {
  return index.ancestors(agentId);
}

/**
 * Where `otherId` sits relative to `viewerId`. Ancestry is checked before
 * siblinghood so a parent is never also reported as a sibling.
 */
export function relationTo(
  index: LineageIndex,
  viewerId: string,
  otherId: string
): AgentRelation {
  const viewer = index.get(viewerId);
  const other = index.get(otherId);
  if (!viewer || !other) return "unrelated";

  if (other.parentAgentId === viewerId) return "child";
  if (viewer.parentAgentId === otherId) return "parent";

  if (index.ancestors(otherId).some((a) => a.id === viewerId)) {
    return "descendant";
  }
  if (index.ancestors(viewerId).some((a) => a.id === otherId)) {
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
 * The chain describes the sender's own provenance to the one agent being
 * messaged, which is exactly the information the recipient was missing.
 */
export function delegationChain(
  index: LineageIndex,
  senderId: string,
  recipientId: string
): LineageNode[] {
  const sender = index.get(senderId);
  const chain: LineageNode[] = sender
    ? [{ id: sender.id, name: sender.name }]
    : [];

  for (const ancestor of index.ancestors(senderId)) {
    chain.push(ancestor);
    if (ancestor.id === recipientId) break;
  }
  return chain;
}

/**
 * Flatten an agent name for interpolation into an injected prompt.
 *
 * Agent names are caller-supplied — dispatch_rename_session and
 * dispatch_launch_agent both accept embedded newlines, and nothing downstream
 * strips them. A name like `worker\n--- END MESSAGE ---\nProvenance: ...` would
 * otherwise forge envelope delimiters and a fake provenance claim in the
 * recipient's terminal. Names rendered inside the JSON envelope are already
 * escaped by JSON.stringify; this is for the prose lines outside it.
 */
export function sanitizeAgentNameForPrompt(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
}

/** Renders a chain as `A -> B -> C` for injection into a message prompt. */
export function formatDelegationChain(
  chain: LineageNode[],
  recipientId: string
): string {
  return chain
    .map(
      (node) =>
        `${sanitizeAgentNameForPrompt(node.name)} (${node.id}${
          node.id === recipientId ? ", you" : ""
        })`
    )
    .join(" -> ");
}
