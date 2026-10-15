import type {
  AgentConfigResponse,
  AgentConfigUpdateRequest,
  AgentUsageResponse,
  ProviderPlansResponse,
} from "@dispatch/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { atomFamily } from "jotai/utils";
import { useEffect } from "react";

import { api } from "@/lib/api";
import { atomWithLocalStorage } from "@/lib/store";

const configKey = (agentId: string | null) => ["agent-config", agentId];
const usageKey = (agentId: string | null) => ["agent-usage", agentId];
const PLANS_KEY = ["usage-plans"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * The last answers, kept across reloads so the usage popover opens on them
 * (each with its age) instead of on placeholders that grow into the real rows.
 */
const lastPlansAtom = atomWithLocalStorage<ProviderPlansResponse | null>(
  "dispatch:usage-plans",
  null,
  {
    validate: (value): value is ProviderPlansResponse | null =>
      value === null ||
      (isObject(value) &&
        typeof value.checkedAt === "string" &&
        Array.isArray(value.providers)),
  }
);

const lastUsageAtom = atomFamily((agentId: string) =>
  atomWithLocalStorage<AgentUsageResponse | null>(
    `dispatch:agent-usage:${agentId}`,
    null,
    {
      validate: (value): value is AgentUsageResponse | null =>
        value === null ||
        (isObject(value) &&
          isObject(value.session) &&
          isObject(value.month) &&
          Array.isArray(value.byModel)),
    }
  )
);

/**
 * The live session's settings (model, effort). An engine can change them on
 * its own (a /model typed at it), so an open pane keeps checking.
 */
export function useAgentConfig(agentId: string | null, active: boolean) {
  return useQuery<AgentConfigResponse>({
    queryKey: configKey(agentId),
    queryFn: () =>
      api(`/api/v1/agents/${encodeURIComponent(agentId ?? "")}/config`),
    enabled: !!agentId && active,
    refetchInterval: active ? 15_000 : false,
    staleTime: 5_000,
  });
}

/** Set one of the live session's options; the answer is the engine's options after it. */
export function useSetAgentConfig(agentId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<AgentConfigResponse, Error, AgentConfigUpdateRequest>({
    mutationFn: (body) =>
      api(`/api/v1/agents/${encodeURIComponent(agentId ?? "")}/config`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(configKey(agentId), data);
    },
  });
}

/**
 * What the agent has used. Context fills while a turn runs, so a running
 * turn polls; a settled one is refetched by the caller (see `refresh`).
 */
export function useAgentUsage(
  agentId: string | null,
  active: boolean,
  turnRunning: boolean
) {
  const queryClient = useQueryClient();
  const [last, setLast] = useAtom(lastUsageAtom(agentId ?? ""));
  const query = useQuery<AgentUsageResponse>({
    queryKey: usageKey(agentId),
    queryFn: () =>
      api(`/api/v1/agents/${encodeURIComponent(agentId ?? "")}/usage`),
    enabled: !!agentId && active,
    refetchInterval: active && turnRunning ? 10_000 : false,
    staleTime: 5_000,
    // The last answer, as initial data rather than a placeholder: it stays on
    // screen if the refetch fails. Dated 0, so it is always read again.
    initialData: (agentId && last) || undefined,
    initialDataUpdatedAt: 0,
  });
  useEffect(() => {
    if (agentId && query.data) setLast(query.data);
  }, [agentId, query.data, setLast]);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: usageKey(agentId) });
  return { ...query, refresh };
}

/** How much of the subscription plans the engines' logins have used. */
export function useProviderPlans(enabled: boolean) {
  const queryClient = useQueryClient();
  const [last, setLast] = useAtom(lastPlansAtom);
  const query = useQuery<ProviderPlansResponse>({
    queryKey: PLANS_KEY,
    queryFn: () => api("/api/v1/usage/plans"),
    enabled,
    staleTime: 60_000,
    // Only read while the usage popover is open; keep the last answer, from
    // this page or a previous one, so an open shows it at once and refreshes
    // behind it. Initial data (not a placeholder) keeps it on screen when the
    // refresh fails, and its own date decides whether it is stale.
    gcTime: Infinity,
    initialData: last ?? undefined,
    initialDataUpdatedAt: last ? Date.parse(last.checkedAt) || 0 : undefined,
  });
  useEffect(() => {
    if (query.data) setLast(query.data);
  }, [query.data, setLast]);
  const refresh = useMutation<ProviderPlansResponse, Error, void>({
    mutationFn: () => api("/api/v1/usage/plans?force=1"),
    onSuccess: (data) => queryClient.setQueryData(PLANS_KEY, data),
  });
  return { ...query, refresh };
}
