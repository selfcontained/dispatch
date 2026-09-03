import { useQuery } from "@tanstack/react-query";

import { type InjectionHoldState } from "@/components/app/types";

/**
 * Whether the server is holding prompt injections for this agent because the
 * user is typing in its terminal. There is no fetch endpoint: use-sse writes
 * `agent.injection_hold_changed` into this query, and the default only seeds
 * first render. A reload during an active hold misses the state until the
 * next transition, which fails safe (not held).
 */
export function useInjectionHoldState(
  agentId: string | null
): InjectionHoldState | undefined {
  const { data } = useQuery<InjectionHoldState>({
    queryKey: ["injection-hold", agentId],
    queryFn: () => ({ held: false, pendingCount: 0, quietMs: 10_000 }),
    enabled: agentId !== null,
    refetchOnWindowFocus: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  return data;
}
