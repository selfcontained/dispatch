import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";

import type { DiffStats } from "@/components/app/types";
import { api } from "@/lib/api";
import { diffIncludeUncommittedAtom } from "@/lib/store";

type DiffStatsResponse = { diffStats: DiffStats | null };

export function diffStatsQueryKey(
  agentId: string,
  includeUncommitted: boolean
): [string, string, boolean] {
  return ["agent-diff", agentId, includeUncommitted];
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
const DIFF_STATS_POLL_INTERVAL_MS = 10_000;
const DIFF_STATS_STALE_TIME_MS = 15_000;

export function useAgentDiffStats(
  agentId: string,
  enabled: boolean
): {
  diffStats: DiffStats | null | undefined;
  refresh: () => void;
} {
  const queryClient = useQueryClient();
  const includeUncommitted = useAtomValue(diffIncludeUncommittedAtom);

  const query = useQuery<DiffStats | null>({
    queryKey: diffStatsQueryKey(agentId, includeUncommitted),
    queryFn: async () => {
      const payload = await api<DiffStatsResponse>(
        `/api/v1/agents/${agentId}/diff-stats?includeUncommitted=${includeUncommitted}`
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
      queryKey: diffStatsQueryKey(agentId, includeUncommitted),
    });
  }, [agentId, includeUncommitted, queryClient]);

  return { diffStats: query.data, refresh };
}
