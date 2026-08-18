/**
 * Agent-type tables and predicates, re-exported from the shared server
 * module so the web client always matches what the server accepts (see
 * apps/server/src/shared/agent-types.ts). Display labels and web-only
 * helpers live here.
 */
import type { AgentType } from "../../../server/src/shared/agent-types";

export {
  AGENT_TYPES,
  CLI_AGENT_TYPES,
  isAgentType,
  isCliAgentType,
  sanitizeEnabledAgentTypes,
  type AgentType,
  type CliAgentType,
} from "../../../server/src/shared/agent-types";

export const AGENT_TYPE_LABELS: Record<AgentType, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  terminal: "Terminal",
};

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
 * A parent that is not in `agents` ends the walk: a plain child outlives its
 * parent's archive (only review children cascade), so it becomes its own card
 * rather than disappearing with the parent.
 */
export function cardIdForAgent(
  agent: { id: string; parentAgentId?: string | null },
  agentsById: Map<string, { id: string; parentAgentId?: string | null }>
): string {
  let current = agent;
  // Bounded by the set size so a corrupted parent link cannot spin forever.
  const seen = new Set<string>([current.id]);
  while (current.parentAgentId) {
    const parent = agentsById.get(current.parentAgentId);
    if (!parent || seen.has(parent.id)) break;
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

export function sortAgentTypes<T extends AgentType>(types: T[]): T[] {
  return [...types].sort((a, b) => {
    if (a === "terminal") return 1;
    if (b === "terminal") return -1;
    return AGENT_TYPE_LABELS[a].localeCompare(AGENT_TYPE_LABELS[b]);
  });
}
