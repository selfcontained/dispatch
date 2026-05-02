import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { DiffStats } from "@/components/app/types";
import { api } from "@/lib/api";

type DiffStatsResponse = { diffStats: DiffStats | null };

export function diffStatsQueryKey(agentId: string): [string, string] {
  return ["agent-diff", agentId];
}

/**
 * Server-pushed diff stats for one agent. The fetch on mount also nudges
 * the server-side refresher (which fans the result out via SSE), so live
 * updates flow through `agent.diff_state_changed` rather than polling.
 * `refresh()` is the tap-to-refresh entry point.
 */
export function useAgentDiffStats(
  agentId: string,
  enabled: boolean
): {
  diffStats: DiffStats | null | undefined;
  refresh: () => void;
} {
  const queryClient = useQueryClient();

  const query = useQuery<DiffStats | null>({
    queryKey: diffStatsQueryKey(agentId),
    queryFn: async () => {
      const payload = await api<DiffStatsResponse>(
        `/api/v1/agents/${agentId}/diff-stats`
      );
      return payload.diffStats;
    },
    enabled,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: diffStatsQueryKey(agentId),
    });
  }, [agentId, queryClient]);

  return { diffStats: query.data, refresh };
}
