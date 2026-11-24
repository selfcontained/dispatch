import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { type AgentType } from "@/lib/agent-types";
import { api } from "@/lib/api";
import {
  type ModelAvailability,
  useUpdateModelAvailability,
} from "@/hooks/use-model-availability";

export type AgentModelOption = {
  id: string;
  label: string;
  /** Not yet seen in a list by the person. */
  isNew?: boolean;
  /** Clears New; set only while the option is new. */
  markSeen?: () => void;
  effort?: import("@dispatch/shared").AgentConfigChoice[];
};
export type CatalogResponse = {
  models: AgentModelCatalog;
  defaults?: Partial<Record<AgentType, string>>;
  availability?: Partial<Record<AgentType, ModelAvailability>>;
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
export function useAgentModelCatalog(
  agentType: AgentType,
  enabled = true,
  provided?: { data?: CatalogResponse; loading: boolean }
): {
  /** The models turned on: what can be chosen. */
  options: AgentModelOption[];
  /** Every model the engine offers: what a saved choice may still hold. */
  allOptions: AgentModelOption[];
  /** A saved id the engine offers, whether or not it is turned on. */
  savedOption: (value: string | null) => AgentModelOption | null;
  defaultModel: string | null;
  /** Whether a newly listed model starts on. */
  autoEnable: boolean;
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
  const query = useQuery<CatalogResponse>({
    queryKey: ["agent-models"],
    enabled: provided ? false : enabled,
    queryFn: () => api("/api/v1/agent-models"),
    staleTime: 5 * 60 * 1000,
    gcTime: Infinity,
  });

  const data = provided ? provided.data : query.data;
  const isLoading = provided ? provided.loading : query.isLoading;
  const loaded = data !== undefined;
  const { mutate } = useUpdateModelAvailability();
  const availability = data?.availability?.[agentType];
  const allOptions = useMemo((): AgentModelOption[] => {
    const models = data?.models?.[agentType] ?? [];
    const unseen = availability?.unseen ?? [];
    if (unseen.length === 0) return models;
    return models.map((option) =>
      unseen.includes(option.id)
        ? {
            ...option,
            isNew: true,
            markSeen: () => mutate({ agentType, seen: [option.id] }),
          }
        : option
    );
  }, [agentType, availability, data, mutate]);
  const options = useMemo(() => {
    const disabled = availability?.disabled ?? [];
    return disabled.length
      ? allOptions.filter((option) => !disabled.includes(option.id))
      : allOptions;
  }, [allOptions, availability]);
  const savedOption = useCallback(
    (value: string | null) =>
      allOptions.find((option) => option.id === value) ?? null,
    [allOptions]
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
  const defaultModel = options.some((option) => option.id === reportedDefault)
    ? (reportedDefault ?? null)
    : null;

  return {
    options,
    allOptions,
    savedOption,
    defaultModel,
    autoEnable: availability?.autoEnable ?? true,
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
export function useAgentEffortCatalog(enabled = true) {
  const { data } = useQuery<CatalogResponse>({
    queryKey: ["agent-models"],
    enabled,
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
  model: string | null,
  enabled = true
) {
  return useAgentEffortCatalog(enabled)(agentType, model);
}
