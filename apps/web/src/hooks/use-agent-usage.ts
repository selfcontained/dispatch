import type {
  AgentConfigResponse,
  AgentConfigUpdateRequest,
  AgentUsageResponse,
  ProviderPlansResponse,
} from "@dispatch/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

const configKey = (agentId: string | null) => ["agent-config", agentId];
const usageKey = (agentId: string | null) => ["agent-usage", agentId];
const PLANS_KEY = ["usage-plans"];

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
  const query = useQuery<AgentUsageResponse>({
    queryKey: usageKey(agentId),
    queryFn: () =>
      api(`/api/v1/agents/${encodeURIComponent(agentId ?? "")}/usage`),
    enabled: !!agentId && active,
    refetchInterval: active && turnRunning ? 10_000 : false,
    staleTime: 5_000,
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: usageKey(agentId) });
  return { ...query, refresh };
}

/** How much of the subscription plans the engines' logins have used. */
export function useProviderPlans(enabled: boolean) {
  const queryClient = useQueryClient();
  const query = useQuery<ProviderPlansResponse>({
    queryKey: PLANS_KEY,
    queryFn: () => api("/api/v1/usage/plans"),
    enabled,
    staleTime: 60_000,
  });
  const refresh = useMutation<ProviderPlansResponse, Error, void>({
    mutationFn: () => api("/api/v1/usage/plans?force=1"),
    onSuccess: (data) => queryClient.setQueryData(PLANS_KEY, data),
  });
  return { ...query, refresh };
}
