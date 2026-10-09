/**
 * An agent's place in its lineage, read off the agents list the app already
 * holds. A stream belongs to the root of a lineage (docs/design/blocks.md,
 * step 2): a child agent has no stream of its own, so its page shows its
 * root's stream filtered to the child, and every stream hook takes the
 * root's id.
 */
import { useCallback } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";

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

export type AgentIdentity = Pick<
  Agent,
  "id" | "name" | "type" | "model" | "persona" | "parentAgentId" | "createdAt"
> & { seat: number | null; rootId: string | null };

const AGENT_RECORD_STALE_TIME = 5 * 60 * 1000;

function agentIdentityOptions(agentId: string | null) {
  return {
    queryKey: ["agent-identity", agentId],
    queryFn: async () => {
      const payload = await api<{ agent: AgentIdentity }>(
        `/api/v1/agents/${encodeURIComponent(agentId!)}/identity`
      );
      return payload.agent;
    },
    enabled: agentId !== null,
    staleTime: AGENT_RECORD_STALE_TIME,
  } as const;
}

/** Reuse the same per-ID queries for the live peers shown by the composer. */
export function useAgentSeats(
  agentIds: readonly string[]
): Readonly<Record<string, number>> {
  const combine = useCallback(
    (results: readonly { data: AgentIdentity | undefined }[]) => {
      const seats: Record<string, number> = {};
      results.forEach((result, index) => {
        if (result.data?.seat != null)
          seats[agentIds[index]!] = result.data.seat;
      });
      return seats;
    },
    [agentIds]
  );
  return useQueries({ queries: agentIds.map(agentIdentityOptions), combine });
}

/** One cached record, including archived agents; live metadata wins. */
export function useAgentRecord(agentId: string | null): AgentIdentity | null {
  const { data } = useQuery(agentIdentityOptions(agentId));
  const { data: agents = [] } = useQuery<Agent[]>({
    queryKey: ["agents"],
    queryFn: fetchAgents,
    enabled: agentId !== null,
    // Reading the live cache from each avatar must not trigger fresh list fetches.
    staleTime: AGENT_RECORD_STALE_TIME,
  });
  const live = agents.find((agent) => agent.id === agentId);
  return data
    ? { ...data, ...live, seat: data.seat }
    : live
      ? { ...live, seat: null, rootId: null }
      : null;
}

/** Live recipient snapshots for conversation-aware composer timing. */
export function useDeliveryAgents(): readonly Agent[] {
  return (
    useQuery<Agent[]>({ queryKey: ["agents"], queryFn: fetchAgents }).data ?? []
  );
}
