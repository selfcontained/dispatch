import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";

import type { DiffStats } from "@/components/app/types";
import { api } from "@/lib/api";
import { useAgentDiff } from "@/hooks/use-agent-diff";
import { diffFileTotals, useVisibleDiffFiles } from "@/hooks/use-visible-diff";
import {
  diffHideTestFilesAtom,
  diffIgnoreWhitespaceAtom,
  diffIncludeUncommittedAtom,
} from "@/lib/store";

type DiffStatsResponse = { diffStats: DiffStats | null };

export function diffStatsQueryKey(
  agentId: string,
  includeUncommitted: boolean
): [string, string, boolean] {
  return ["agent-diff", agentId, includeUncommitted];
}

/**
 * Applies the Changes tab's "Hide test files" setting to server totals.
 *
 * `/diff-stats` reports both cuts of the numbers, so every badge honours the
 * setting without pulling down a whole diff to filter a file list — which is
 * what the sidebar and session-settings badges need, since neither has a file
 * list on screen to derive totals from.
 */
function applyTestFileFilter(
  stats: DiffStats | null | undefined,
  hideTestFiles: boolean
): DiffStats | null | undefined {
  if (!stats || !hideTestFiles) return stats;
  // A server that predates the split sends no `excludingTests` at all; leaving
  // the unfiltered numbers alone is the only honest thing to show in that case.
  if (!stats.excludingTests) return stats;
  return { ...stats, ...stats.excludingTests };
}

/**
 * Server-pushed diff stats for one agent. Live updates flow through
 * `agent.diff_state_changed` SSE whenever the agent emits a status event,
 * which covers the common "agent is actively working" case. While the
 * panel is open we also poll on a slow cadence and refetch on tab focus
 * so the badge stays current during quiet periods (no agent events) and
 * after returning from another tab. `refresh()` is the tap-to-refresh
 * entry point. Polling stops automatically when `enabled` flips false.
 *
 * The returned totals honour the Changes tab's "Hide test files" setting, and
 * the raw cut is not exposed. Filtering here rather than at each call site is
 * deliberate: a badge added later is covered by default, where the per-call-site
 * version is what let the sidebar drift out of sync in the first place. A
 * consumer that genuinely needs unfiltered totals should widen this hook rather
 * than read the query around it.
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
  const hideTestFiles = useAtomValue(diffHideTestFilesAtom);

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

  const diffStats = useMemo(
    () => applyTestFileFilter(query.data, hideTestFiles),
    [query.data, hideTestFiles]
  );

  return { diffStats, refresh };
}

/**
 * Diff stats for the header badge, derived from the Changes tab's own file list
 * whenever that list is on screen.
 *
 * The rule is deliberately unconditional: while the Changes tab is visible the
 * badge is `diffFileTotals` of exactly the files rendered below it, so the two
 * cannot disagree for any reason — not the test-file filter, and not the
 * whitespace one either (`/diff-stats` computes without `-w` while `/diff`
 * honours it, so a whitespace-only file counts on the server but never appears
 * in the list). It reuses the payload the tab already has cached, so it costs
 * no extra request.
 *
 * With the tab closed there is no list to agree with, and a cached diff would
 * go stale while `/diff-stats` keeps polling — a frozen badge is worse than a
 * slightly differently-derived one — so the server totals are used as-is.
 * Those already honour "Hide test files"; what the list adds on top is the
 * whitespace agreement, which only `/diff` can settle.
 */
export function useVisibleDiffStats(
  agentId: string,
  enabled: boolean,
  changesVisible: boolean
): {
  diffStats: DiffStats | null | undefined;
  refresh: () => void;
} {
  const { diffStats, refresh: refreshStats } = useAgentDiffStats(
    agentId,
    enabled
  );
  const ignoreWhitespace = useAtomValue(diffIgnoreWhitespaceAtom);
  // Only ever reads the query the visible Changes tab is already driving —
  // same key, shared cache. This hook must never be what fetches a full diff.
  const { data, refresh: refreshDiff } = useAgentDiff(
    agentId,
    enabled && changesVisible,
    ignoreWhitespace
  );
  const visibleFiles = useVisibleDiffFiles(data);

  const refresh = useCallback(() => {
    refreshStats();
    refreshDiff();
  }, [refreshStats, refreshDiff]);

  return useMemo(() => {
    // A truncated list is missing files the server did count, so its totals
    // would understate the change — keep the server's in that case.
    if (!changesVisible || !diffStats || !data || data.truncatedFileCount) {
      return { diffStats, refresh };
    }
    return {
      diffStats: { ...diffStats, ...diffFileTotals(visibleFiles) },
      refresh,
    };
  }, [changesVisible, diffStats, data, visibleFiles, refresh]);
}
