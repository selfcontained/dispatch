/**
 * What an agent's running turn is doing, in the stream's own words. Every
 * `stream.entry` for a turn records it, so it follows the turn as its steps
 * land, for agents whose Chat tab is not open too. An agent the event stream
 * has not reported on since it (re)connected has its current turn read once,
 * since a turn already running then will not send another entry until its
 * next step.
 */
import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { AgentTurnResponse, StreamEntry } from "@dispatch/shared";

import { runningTurnVerb } from "@/components/app/chat/turn/registry";
import { isTurnEntry, turnTrace } from "@/components/app/chat/turn/trace";
import { api } from "@/lib/api";

/**
 * One label per turn block: an older turn published again (a reaction, a
 * reply in its thread) records its own, and never the running turn's.
 */
function turnLabelQueryKey(agentId: string, blockId: string) {
  return ["agent-turn-label", agentId, blockId] as const;
}

/**
 * Whether the event stream has sent a turn entry for the agent since it last
 * (re)connected. A new turn for such an agent is announced (`agent.upsert`)
 * just before its first entry arrives, so there is nothing to read for it.
 */
function reportedQueryKey(agentId: string) {
  return ["agent-turn-reported", agentId] as const;
}

/**
 * Labels and flags are kept until replaced, not collected after five minutes
 * unwatched: a reported agent's label is never read again, so a row that
 * mounts mid-step (a card expanded six minutes into `pnpm test`) must find
 * it still here. A turn's label goes once it is over and unwatched.
 */
const keptClients = new WeakSet<QueryClient>();

function keepTurnLabels(queryClient: QueryClient): void {
  if (keptClients.has(queryClient)) return;
  keptClients.add(queryClient);
  queryClient.setQueryDefaults(["agent-turn-label"], { gcTime: Infinity });
  queryClient.setQueryDefaults(["agent-turn-reported"], { gcTime: Infinity });
}

/** The agent's labels for turns that are over and that no row shows. */
function pruneTurnLabels(queryClient: QueryClient, agentId: string): void {
  for (const query of queryClient
    .getQueryCache()
    .findAll({ queryKey: ["agent-turn-label", agentId] })) {
    if (query.state.data == null && query.getObserversCount() === 0) {
      queryClient.getQueryCache().remove(query);
    }
  }
}

/** The line the turn's own summary row shows while it runs; null once settled. */
function turnEntryLabel(entry: StreamEntry): string | null {
  if (!isTurnEntry(entry)) return null;
  const turn = entry.block.turn;
  return turn.settled ? null : runningTurnVerb(turnTrace(turn).steps);
}

/** Record the running step from a `stream.entry`; a settled turn clears it. */
export function recordTurnLabel(
  queryClient: QueryClient,
  entry: StreamEntry
): void {
  if (!isTurnEntry(entry)) return;
  keepTurnLabels(queryClient);
  const agentId = entry.block.turn.agentId;
  if (!queryClient.getQueryData<boolean>(reportedQueryKey(agentId))) {
    queryClient.setQueryData(reportedQueryKey(agentId), true);
  }
  pruneTurnLabels(queryClient, agentId);
  queryClient.setQueryData<string | null>(
    turnLabelQueryKey(agentId, entry.block.id),
    turnEntryLabel(entry)
  );
}

/**
 * The event stream (re)connected and may have missed steps: every agent's
 * current turn is read again.
 */
export function refreshTurnLabels(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ["agent-turn-label"] });
  // Labels it now reads again are stale, so each one is read as it enables.
  queryClient.setQueriesData<boolean>(
    { queryKey: ["agent-turn-reported"] },
    false
  );
}

/** The current turn's running step, or null when there is no running turn. */
export function useAgentTurnLabel(
  agentId: string,
  blockId: string | null
): string | null {
  const queryClient = useQueryClient();
  keepTurnLabels(queryClient);
  const queryKey = turnLabelQueryKey(agentId, blockId ?? "");
  const { data: reported } = useQuery<boolean>({
    queryKey: reportedQueryKey(agentId),
    queryFn: () => false,
    enabled: false,
    staleTime: Infinity,
  });
  const { data } = useQuery<string | null>({
    queryKey,
    queryFn: async () => {
      const asked = Date.now();
      const { entry } = await api<AgentTurnResponse>(
        `/api/v1/agents/${agentId}/turn`
      );
      // A stream entry that landed while this was in flight is newer.
      const state = queryClient.getQueryState<string | null>(queryKey);
      if (state && state.dataUpdatedAt >= asked) return state.data ?? null;
      if (!entry) return null;
      if (entry.block.id !== blockId) {
        // A newer turn than the card knows of yet: it keeps its own label
        // for when the card catches up, unless its entries already have.
        if (
          isTurnEntry(entry) &&
          queryClient.getQueryData(
            turnLabelQueryKey(entry.block.turn.agentId, entry.block.id)
          ) === undefined
        ) {
          recordTurnLabel(queryClient, entry);
        }
        return null;
      }
      return turnEntryLabel(entry);
    },
    // A reported agent's turn is recorded by its own entries.
    enabled: blockId !== null && !reported,
    staleTime: Infinity,
  });
  return blockId ? (data ?? null) : null;
}
