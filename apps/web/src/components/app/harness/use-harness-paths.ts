import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { HarnessPath, HarnessPathsResponse } from "@dispatch/shared";
import { useEffect, useState } from "react";

import { api } from "@/lib/api";

const DEBOUNCE_MS = 150;

export function harnessPathsQueryKey(agentId: string | null, query: string) {
  return ["harness-paths", agentId, query] as const;
}

/**
 * Completions for the composer's "@" path picker. `query` is what follows
 * the "@", or null while no picker is open. Typing is debounced, and the
 * previous list stays up while the next one loads so the menu does not
 * flicker between keystrokes.
 */
export function useHarnessPaths(
  agentId: string | null,
  query: string | null
): HarnessPath[] {
  const [settled, setSettled] = useState(query);
  useEffect(() => {
    if (query === null) {
      setSettled(null);
      return;
    }
    const timer = setTimeout(() => setSettled(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const active = query !== null ? (settled ?? query) : null;
  const result = useQuery({
    queryKey: harnessPathsQueryKey(agentId, active ?? ""),
    queryFn: () =>
      api<HarnessPathsResponse>(
        `/api/v1/agents/${agentId}/harness/paths?q=${encodeURIComponent(active ?? "")}`
      ),
    enabled: agentId !== null && active !== null,
    staleTime: 10_000,
    placeholderData: keepPreviousData,
  });
  if (query === null) return [];
  return result.data?.paths ?? [];
}
