/**
 * An agent's place in its lineage, read off the agents list the app already
 * holds. A stream belongs to the root of a lineage (docs/design/blocks.md,
 * step 2): a child agent has no stream of its own, so its page shows its
 * root's stream filtered to the child, and every stream hook takes the
 * root's id.
 */
import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";

import type { Agent } from "@/components/app/types";
import { api } from "@/lib/api";

type Lineage = Pick<Agent, "id" | "parentAgentId">;

/** How far up or down a lineage the walks go; a cycle cannot loop forever. */
const MAX_DEPTH = 32;

/**
 * The root of an agent's lineage: itself when it has no parent, otherwise
 * the top of its `parentAgentId` chain. An agent the list does not know
 * (archived, or from another repository) is its own root, so the result is
 * always usable as a stream id.
 */
export function rootAgentIdOf(
  agentId: string,
  agents: readonly Lineage[]
): string {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  let current = agentId;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const parent = byId.get(current)?.parentAgentId;
    if (!parent || !byId.has(parent)) return current;
    current = parent;
  }
  return current;
}

/** Every agent under `agentId` (children, their children, …), never itself. */
export function descendantAgentIds(
  agentId: string,
  agents: readonly Lineage[]
): Set<string> {
  const children = new Map<string, string[]>();
  for (const agent of agents) {
    if (!agent.parentAgentId) continue;
    const list = children.get(agent.parentAgentId);
    if (list) list.push(agent.id);
    else children.set(agent.parentAgentId, [agent.id]);
  }
  const out = new Set<string>();
  let frontier = [agentId];
  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const child of children.get(id) ?? []) {
        if (out.has(child) || child === agentId) continue;
        out.add(child);
        next.push(child);
      }
    }
    frontier = next;
  }
  return out;
}

export async function fetchAgents(): Promise<Agent[]> {
  const payload = await api<{ agents: Agent[] }>("/api/v1/agents");
  return payload.agents;
}

/**
 * The root of `agentId`'s lineage, or null until the agents list has loaded
 * (a child's page must not fetch its own, empty stream in the meantime).
 */
export function useRootAgentId(agentId: string | null): string | null {
  const select = useCallback(
    (agents: Agent[]) => (agentId ? rootAgentIdOf(agentId, agents) : null),
    [agentId]
  );
  const { data } = useQuery<Agent[], Error, string | null>({
    queryKey: ["agents"],
    queryFn: fetchAgents,
    select,
    enabled: agentId !== null,
  });
  return data ?? null;
}

const NO_DESCENDANTS: ReadonlySet<string> = new Set();

/** The ids under `agentId` in the live agents list; empty until loaded. */
export function useDescendantAgentIds(
  agentId: string | null
): ReadonlySet<string> {
  const select = useCallback(
    (agents: Agent[]) =>
      agentId ? descendantAgentIds(agentId, agents) : NO_DESCENDANTS,
    [agentId]
  );
  const { data } = useQuery<Agent[], Error, ReadonlySet<string>>({
    queryKey: ["agents"],
    queryFn: fetchAgents,
    select,
    enabled: agentId !== null,
  });
  return data ?? NO_DESCENDANTS;
}

/**
 * One agent as the live agents list has it, or null (not loaded yet, or
 * archived). A card that stands for an agent reads it here, so its name,
 * model and status follow the agent rather than what was true at launch.
 */
export function useAgentRecord(agentId: string | null): Agent | null {
  const select = useCallback(
    (agents: Agent[]) => agents.find((agent) => agent.id === agentId) ?? null,
    [agentId]
  );
  const { data } = useQuery<Agent[], Error, Agent | null>({
    queryKey: ["agents"],
    queryFn: fetchAgents,
    select,
    enabled: agentId !== null,
  });
  return data ?? null;
}
