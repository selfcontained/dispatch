import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useAtomValue } from "jotai";

import { type AgentType } from "@/lib/agent-types";
import { api } from "@/lib/api";
import {
  INITIAL_AVAILABILITY,
  modelAvailabilityAtom,
  previewModels,
} from "@/lib/model-availability-preview";

export type AgentModelOption = {
  id: string;
  label: string;
  effort?: import("@dispatch/shared").AgentConfigChoice[];
};
type CatalogResponse = {
  models: AgentModelCatalog;
  defaults?: Partial<Record<AgentType, string>>;
};
export type AgentModelCatalog = Partial<Record<AgentType, AgentModelOption[]>>;

/**
 * The model catalog, keyed by runtime: what each engine last said it could
 * run here, or the shipped seed until one has. Every dialog that offers a
 * model picker reads it through here so they share one cache entry — a second
 * copy of this query with a different key or cache config would silently split
 * the cache. A list an engine publishes later reaches an open picker through
 * the `agent_models.changed` event, which invalidates this key (use-sse.ts).
 */
export function useAgentModelCatalog(agentType: AgentType): {
  /** The models turned on: what pickers offer. */
  options: AgentModelOption[];
  /** Every model the engine offers, including those turned off. */
  allOptions: (AgentModelOption & { isNew?: boolean })[];
  /** What Default launches. */
  defaultModel: string | null;
  engineDefault: string | null;
  /** A saved id that the engine offers but is turned off. */
  offModel: (value: string | null) => AgentModelOption | null;
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
  const { data, isLoading } = useQuery<CatalogResponse>({
    queryKey: ["agent-models"],
    queryFn: () => api("/api/v1/agent-models"),
    staleTime: 5 * 60 * 1000,
    gcTime: Infinity,
  });

  const loaded = data !== undefined;
  const { off, replacement, release } =
    useAtomValue(modelAvailabilityAtom)[agentType] ?? INITIAL_AVAILABILITY;
  const allOptions = useMemo(
    () => previewModels(agentType, data?.models?.[agentType] ?? [], release),
    [agentType, data, release]
  );
  const options = useMemo(
    () => allOptions.filter((option) => !off.includes(option.id)),
    [allOptions, off]
  );
  const offModel = useCallback(
    (value: string | null) =>
      value !== null && off.includes(value)
        ? (allOptions.find((option) => option.id === value) ?? null)
        : null,
    [allOptions, off]
  );

  const normalizeModel = useCallback(
    (value: string | null): string | null =>
      loaded &&
      value !== null &&
      !allOptions.some((option) => option.id === value)
        ? null
        : value,
    [allOptions, loaded]
  );

  const reportedDefault = data?.defaults?.[agentType];
  const engineDefault = allOptions.some(
    (option) => option.id === reportedDefault
  )
    ? (reportedDefault ?? null)
    : null;
  const defaultModel =
    engineDefault && off.includes(engineDefault) ? replacement : engineDefault;

  return {
    options,
    allOptions,
    defaultModel,
    engineDefault,
    offModel,
    loading: isLoading,
    loaded,
    normalizeModel,
  };
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
  const { data } = useQuery<CatalogResponse>({
    queryKey: ["agent-models"],
    queryFn: () => api("/api/v1/agent-models"),
    staleTime: 5 * 60 * 1000,
    gcTime: Infinity,
  });
  return data?.models;
}

/** Shares the model catalog cache: no separate hardcoded effort list. */
export function useAgentEffortCatalog() {
  const { data } = useQuery<CatalogResponse>({
    queryKey: ["agent-models"],
    queryFn: () => api("/api/v1/agent-models"),
    staleTime: 5 * 60 * 1000,
    gcTime: Infinity,
  });
  return (agentType: AgentType, model: string | null) => {
    const selected = model ?? data?.defaults?.[agentType];
    return data?.models?.[agentType]?.find((option) => option.id === selected)
      ?.effort;
  };
}

export function useAgentEffortChoices(
  agentType: AgentType,
  model: string | null
) {
  return useAgentEffortCatalog()(agentType, model);
}
