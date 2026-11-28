import { pluginStatusKey } from "@/hooks/use-plugin-status";
import { providerPlansKey, useProviderPlans } from "@/hooks/use-agent-usage";
import type { RunnerEngine } from "@dispatch/runner-protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import {
  engineScopeKey,
  type EngineInventoryEntry,
  type EngineOperation,
  type EngineOperationAck,
  type EngineScope,
} from "@dispatch/runner-protocol/engine-management";

import { engineStatusKey } from "@/hooks/use-engines";
import { api } from "@/lib/api";

/**
 * Scope-aware engine inventory and install/update/sign-in, for an engine
 * running locally or on a named runner (runner-wide, not per-workspace).
 * Expects the HTTP routes:
 *
 * - `GET  /api/v1/engine-management/inventory?{scope query}` → `{ entries }`,
 *   null while a runner's engines are not known yet
 * - `POST /api/v1/engine-management/operations` with `{ scope, operation }`
 *   body → `{ ack }`
 *
 * where the scope query is `scope=local` or `scope=runner&runnerId=<id>`.
 * Both routes back onto `EngineManager`
 * (`apps/server/src/agents/remote/engine-manager.ts`).
 */

import { engineScopeQuery as scopeQuery } from "@/lib/engine-management";

export function runnerEnginesKey(scope: EngineScope) {
  return ["runner-engines", engineScopeKey(scope)] as const;
}

/** Whether an operation leaves something still running, worth polling for. */
function hasPendingWork(
  entries: EngineInventoryEntry[] | null | undefined
): boolean {
  // Sign-in is the only state this inventory can't settle on its own; an
  // install/update's completion is the inventory's own version/installed
  // change, so no separate "pending" flag is needed here.
  return (
    entries?.some((entry) => entry.signedIn === null && entry.installed) ??
    false
  );
}

export function useRunnerEngineInventory(scope: EngineScope, enabled = true) {
  return useQuery<{ entries: EngineInventoryEntry[] | null }>({
    queryKey: runnerEnginesKey(scope),
    enabled,
    queryFn: () =>
      api(`/api/v1/engine-management/inventory?${scopeQuery(scope)}`),
    refetchInterval: (query) =>
      hasPendingWork(query.state.data?.entries) ? 2_000 : 10_000,
  });
}

/**
 * A runner refuses engine work while it updates, so what was read then is
 * the last known state, or a failure. Read it again when the update ends.
 */
export function useEnginesRefreshAfterUpdate(
  runnerId: string,
  updating: boolean
) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!updating) return;
    return () => {
      for (const queryKey of [
        runnerEnginesKey({ kind: "runner", runnerId }),
        pluginStatusKey({ kind: "runner", runnerId }),
        providerPlansKey({ kind: "runner", runnerId }),
        engineStatusKey({ kind: "runner", runnerId }),
      ])
        void queryClient.invalidateQueries({ queryKey });
    };
  }, [queryClient, runnerId, updating]);
}

/** Run one operation against a scope and refresh its inventory on completion. */
export function useRunnerEngineOperation(scope: EngineScope) {
  const queryClient = useQueryClient();
  const key = runnerEnginesKey(scope);
  return useMutation<{ ack: EngineOperationAck }, Error, EngineOperation>({
    mutationFn: (operation) =>
      api(`/api/v1/engine-management/operations`, {
        method: "POST",
        body: JSON.stringify({ scope, operation }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: key });
      void queryClient.invalidateQueries({ queryKey: engineStatusKey(scope) });
    },
  });
}

export { runnerEngineCapability } from "@/lib/engine-management";
import { runnerEngineCapability } from "@/lib/engine-management";
export function useRunnerModelCatalog(
  runnerId: string | null,
  engine: RunnerEngine,
  online: boolean,
  model?: string
) {
  return useQuery({
    queryKey: ["runner-engine-catalog", runnerId, engine, model],
    enabled: Boolean(runnerId && online),
    retry: false,
    queryFn: async () =>
      (
        await runnerEngineCapability(
          runnerId!,
          { type: "model_catalog", engine, ...(model ? { model } : {}) },
          "model_catalog"
        )
      ).catalog,
  });
}

export function useRunnerProviderUsage(
  runnerId: string | null,
  enabled: boolean,
  scope?: EngineScope
) {
  return useProviderPlans(
    Boolean(runnerId && enabled),
    scope ?? { kind: "runner", runnerId: runnerId ?? "" }
  );
}
