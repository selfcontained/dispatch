/**
 * What an agent's running turn is doing, in the stream's own words. Nothing is
 * fetched for it; every `stream.entry` for a turn records it, so it follows
 * the turn as its steps land, for agents whose Chat tab is not open too.
 */
import { type QueryClient, useQuery } from "@tanstack/react-query";
import type { StreamEntry } from "@dispatch/shared";

import type { Step } from "@/components/app/chat/turn/contracts";
import { activeStepLabel } from "@/components/app/chat/turn/registry";
import { isTurnEntry } from "@/components/app/chat/turn/trace";

type TurnStepLabel = { blockId: string; label: string | null };

function turnLabelQueryKey(agentId: string) {
  return ["agent-turn-label", agentId] as const;
}

/** Record the running step from a `stream.entry`; a settled turn clears it. */
export function recordTurnLabel(
  queryClient: QueryClient,
  entry: StreamEntry
): void {
  if (!isTurnEntry(entry)) return;
  const turn = entry.block.turn;
  const label =
    (turn.settled
      ? undefined
      : activeStepLabel(
          turn.trace.steps.map(
            (step): Step => ({
              id: step.id,
              kind: step.kind,
              label: step.label,
              status: step.status,
              startedAt: 0,
              detail: step.detail,
            })
          )
        )) ?? null;
  queryClient.setQueryData<TurnStepLabel>(turnLabelQueryKey(turn.agentId), {
    blockId: entry.block.id,
    label,
  });
}

/** The current turn's running step, or null when no step is running. */
export function useAgentTurnLabel(
  agentId: string,
  blockId: string | null
): string | null {
  const { data } = useQuery<TurnStepLabel | null>({
    queryKey: turnLabelQueryKey(agentId),
    queryFn: () => null,
    enabled: false,
    staleTime: Infinity,
  });
  return blockId && data?.blockId === blockId ? data.label : null;
}
