/**
 * What an agent's running turn is doing, in the stream's own words: the verb
 * the activity rail folds to ("edited turns.ts", "ran pnpm test"). Nothing is
 * fetched for it; every `stream.entry` for a turn records it, so it follows
 * the turn as its steps land, for agents whose Chat tab is not open too.
 */
import { type QueryClient, useQuery } from "@tanstack/react-query";
import type { StreamEntry } from "@dispatch/shared";

import { turnLabelFromSteps } from "@/components/app/chat/turn/registry";
import { isTurnEntry, turnStep } from "@/components/app/chat/turn/trace";

function turnLabelQueryKey(agentId: string) {
  return ["agent-turn-label", agentId] as const;
}

/** Record the running turn's verb from a `stream.entry`; a settled turn clears it. */
export function recordTurnLabel(
  queryClient: QueryClient,
  entry: StreamEntry
): void {
  if (!isTurnEntry(entry)) return;
  const turn = entry.block.turn;
  const label = turn.settled
    ? null
    : (turnLabelFromSteps(turn.trace.steps.map(turnStep)) ?? null);
  queryClient.setQueryData<string | null>(
    turnLabelQueryKey(turn.agentId),
    label
  );
}

/** The running turn's verb, or null until one of its steps has landed. */
export function useAgentTurnLabel(agentId: string): string | null {
  const { data } = useQuery<string | null>({
    queryKey: turnLabelQueryKey(agentId),
    queryFn: () => null,
    enabled: false,
    staleTime: Infinity,
  });
  return data ?? null;
}
