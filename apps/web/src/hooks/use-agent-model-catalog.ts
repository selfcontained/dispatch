import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { type AgentType } from "@/lib/agent-types";
import { api } from "@/lib/api";

export type AgentModelOption = { id: string; label: string };
export type AgentModelCatalog = Partial<Record<AgentType, AgentModelOption[]>>;

/**
 * The model catalog, keyed by runtime: what each engine last said it could
 * run here, or the shipped seed until one has. Every dialog that offers a
 * model picker reads it through here so they share one cache entry — a second
 * copy of this query with a different key or cache config would silently split
 * the cache. It goes stale after a few minutes so a list an engine published
 * since reaches the picker without a reload.
 */
export function useAgentModelCatalog(agentType: AgentType): {
  options: AgentModelOption[];
  loading: boolean;
  /** True only once a catalog has actually arrived — a failed fetch stays
   * false so callers don't mistake "no catalog" for "empty catalog". */
  loaded: boolean;
  /** Map a stored model id to something the server will accept: ids absent
   * from the loaded catalog become null (Default). Forms that persist a model
   * must send this instead of raw state — the server rejects retired ids, and
   * the picker either coerces them to Default silently or (for types with no
   * catalog) isn't rendered at all, leaving the user no way to clear the
   * stale value. While the catalog hasn't loaded, values pass through
   * untouched so a failed fetch never wipes a saved model. */
  normalizeModel: (value: string | null) => string | null;
} {
  const { data, isLoading } = useQuery<{ models: AgentModelCatalog }>({
    queryKey: ["agent-models"],
    queryFn: () => api("/api/v1/agent-models"),
    staleTime: 5 * 60 * 1000,
    gcTime: Infinity,
  });

  const loaded = data !== undefined;
  const options = useMemo(
    () => data?.models?.[agentType] ?? [],
    [agentType, data]
  );

  const normalizeModel = useCallback(
    (value: string | null): string | null =>
      loaded && value !== null && !options.some((option) => option.id === value)
        ? null
        : value,
    [loaded, options]
  );

  return { options, loading: isLoading, loaded, normalizeModel };
}

/**
 * A model id as the catalog names it ("Fable 5.1" for
 * "claude-fable-5-1[1m]"), or the id itself when the catalog does not know
 * it. For the chips in the stream; the id stays in the title.
 */
export function agentModelLabel(
  catalog: AgentModelCatalog | undefined,
  agentType: string | null | undefined,
  model: string
): string {
  const options = agentType ? catalog?.[agentType as AgentType] : undefined;
  return options?.find((o) => o.id === model)?.label ?? model;
}

/** The whole catalog, for a component that labels many agents' models at once. */
export function useAgentModelCatalogData(): AgentModelCatalog | undefined {
  const { data } = useQuery<{ models: AgentModelCatalog }>({
    queryKey: ["agent-models"],
    queryFn: () => api("/api/v1/agent-models"),
    staleTime: 5 * 60 * 1000,
    gcTime: Infinity,
  });
  return data?.models;
}
