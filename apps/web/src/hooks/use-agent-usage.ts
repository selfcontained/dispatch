import type {
  AgentConfigResponse,
  AgentConfigUpdateRequest,
  AgentUsageResponse,
  ProviderPlansResponse,
} from "@dispatch/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useEffect } from "react";

import type { EngineScope } from "@dispatch/runner-protocol/engine-management";
import { LOCAL_ENGINE_SCOPE, engineScopeQuery } from "@/lib/engine-management";
import { runnerEngineCapability } from "@/lib/engine-management";
import { createClientId } from "@/lib/client-id";
import { api } from "@/lib/api";
import { atomWithLocalStorage } from "@/lib/store";

const configKey = (agentId: string | null) => ["agent-config", agentId];
const usageKey = (agentId: string | null) => ["agent-usage", agentId];
export const providerPlansKey = (scope: EngineScope) =>
  ["usage-plans", engineScopeQuery(scope)] as const;
type PlansReport = ProviderPlansResponse & { codexResetAccount?: string };
async function readProviderPlans(
  scope: EngineScope,
  force = false
): Promise<PlansReport> {
  return (
    await runnerEngineCapability(
      scope,
      { type: "provider_usage", ...(force && { force: true }) },
      "provider_usage"
    )
  ).usage;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * The last plans answer, kept across reloads so the usage popover opens on
 * it (with its age) instead of on placeholders that grow into the real rows.
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
 * What the agent has used. Read once an agent is open and again when the
 * caller asks (`refresh`, on a turn starting or settling); never polled —
 * while a turn runs, its stream entry carries the context as it fills.
 */
export function useAgentUsage(agentId: string | null, active: boolean) {
  const queryClient = useQueryClient();
  const query = useQuery<AgentUsageResponse>({
    queryKey: usageKey(agentId),
    queryFn: () =>
      api(`/api/v1/agents/${encodeURIComponent(agentId ?? "")}/usage`),
    enabled: !!agentId && active,
    staleTime: 5_000,
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: usageKey(agentId) });
  return { ...query, refresh };
}

/** What Codex answered to spending one of the account's limit resets. */
export type CodexResetResult = {
  /** `ok` when windows were reset; `nothing_to_reset` or `no_credit` otherwise. */
  code: string;
  windowsReset: number;
};

/**
 * Spend one of the Codex account's limit resets. Only ever sent from the
 * confirmed dialog; the plans are read again once it answers.
 */
export function useConsumeCodexReset(scope: EngineScope = LOCAL_ENGINE_SCOPE) {
  const queryClient = useQueryClient();
  return useMutation<CodexResetResult, Error, void>({
    mutationFn: async () => {
      const report = queryClient.getQueryData<PlansReport>(
        providerPlansKey(scope)
      );
      const account =
        report?.codexResetAccount ??
        (await readProviderPlans(scope)).codexResetAccount;
      if (!account)
        throw new Error(
          "Codex did not confirm the reset. Check usage before trying again."
        );
      return runnerEngineCapability(
        scope,
        { type: "codex_reset", account, requestId: createClientId() },
        "codex_reset"
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: providerPlansKey(scope) }),
  });
}

/** How much of the subscription plans the engines' logins have used. */
export function useProviderPlans(
  enabled: boolean,
  scope: EngineScope = LOCAL_ENGINE_SCOPE
) {
  const queryClient = useQueryClient();
  const [stored, setLast] = useAtom(lastPlansAtom);
  const local = scope.kind === "local";
  const last = local ? stored : null;
  const query = useQuery<ProviderPlansResponse>({
    queryKey: providerPlansKey(scope),
    queryFn: () => readProviderPlans(scope),
    enabled,
    staleTime: 60_000,
    // Read when enabled; the usage chip enables this while mounted, without
    // polling, so its closed-state reminder can use fresh data. Keep the last answer, from
    // this page or a previous one, so an open shows it at once and refreshes
    // behind it. Initial data (not a placeholder) keeps it on screen when the
    // refresh fails, and its own date decides whether it is stale.
    gcTime: Infinity,
    initialData: last ?? undefined,
    initialDataUpdatedAt: last ? Date.parse(last.checkedAt) || 0 : undefined,
  });
  useEffect(() => {
    if (local && query.data) setLast(query.data);
  }, [query.data, setLast, local]);
  const refresh = useMutation<ProviderPlansResponse, Error, void>({
    mutationFn: () => readProviderPlans(scope, true),
    onSuccess: (data) =>
      queryClient.setQueryData(providerPlansKey(scope), data),
  });
  return { ...query, refresh };
}
