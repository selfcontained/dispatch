import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { DiffStats } from "@/components/app/types";
import { api } from "@/lib/api";

type DiffStatsResponse = { diffStats: DiffStats | null };

export function diffStatsQueryKey(agentId: string): [string, string] {
  return ["agent-diff", agentId];
}

/**
 * Server-pushed diff stats for one agent. Live updates flow through
 * `agent.diff_state_changed` SSE whenever the agent emits a status event,
 * which covers the common "agent is actively working" case. While the
 * panel is open we also poll on a slow cadence and refetch on tab focus
 * so the badge stays current during quiet periods (no agent events) and
 * after returning from another tab. `refresh()` is the tap-to-refresh
 * entry point. Polling stops automatically when `enabled` flips false.
 */
const DIFF_STATS_POLL_INTERVAL_MS = 30_000;
const DIFF_STATS_STALE_TIME_MS = 15_000;

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
    refetchOnWindowFocus: true,
    refetchInterval: DIFF_STATS_POLL_INTERVAL_MS,
    staleTime: DIFF_STATS_STALE_TIME_MS,
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: diffStatsQueryKey(agentId),
    });
  }, [agentId, queryClient]);

  return { diffStats: query.data, refresh };
}
