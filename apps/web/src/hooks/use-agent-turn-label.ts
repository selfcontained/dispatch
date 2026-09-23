/**
 * What an agent's running turn is doing, in the stream's own words. Every
 * `stream.entry` for a turn records it, so it follows the turn as its steps
 * land, for agents whose Chat tab is not open too. A turn already running
 * when the page loads (or the event stream reconnects) is read once.
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
  queryClient.setQueryData<string | null>(
    turnLabelQueryKey(entry.block.turn.agentId, entry.block.id),
    turnEntryLabel(entry)
  );
}

/** The current turn's running step, or null when there is no running turn. */
export function useAgentTurnLabel(
  agentId: string,
  blockId: string | null
): string | null {
  const queryClient = useQueryClient();
  const queryKey = turnLabelQueryKey(agentId, blockId ?? "");
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
      if (!entry || entry.block.id !== blockId) return null;
      return turnEntryLabel(entry);
    },
    enabled: blockId !== null,
    staleTime: Infinity,
  });
  return blockId ? (data ?? null) : null;
}
