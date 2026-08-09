import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { type AgentType } from "@/lib/agent-types";
import { api } from "@/lib/api";

export type AgentModelOption = { id: string; label: string };
export type AgentModelCatalog = Partial<Record<AgentType, AgentModelOption[]>>;

/**
 * Source-controlled model catalog, keyed by runtime. Every dialog that offers a
 * model picker reads it through here so they share one cache entry — a second
 * copy of this query with a different key or cache config would silently split
 * the cache.
 */
export function useAgentModelCatalog(agentType: AgentType): {
  options: AgentModelOption[];
  loading: boolean;
  /** True only once a catalog has actually arrived — a failed fetch stays
   * false so callers don't mistake "no catalog" for "empty catalog". */
  loaded: boolean;
} {
  const { data, isLoading } = useQuery<{ models: AgentModelCatalog }>({
    queryKey: ["agent-models"],
    queryFn: () => api("/api/v1/agent-models"),
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const options = useMemo(
    () => data?.models?.[agentType] ?? [],
    [agentType, data]
  );

  return { options, loading: isLoading, loaded: data !== undefined };
}
