import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  engineScopeKey,
  type EngineInventoryEntry,
  type EngineOperation,
  type EngineOperationAck,
  type EngineScope,
} from "@dispatch/runner-protocol/engine-management";

import { api } from "@/lib/api";

/**
 * Scope-aware engine inventory and install/update/sign-in, for an engine
 * running locally or on a named runner (runner-wide, not per-workspace).
 * Expects the HTTP routes:
 *
 * - `GET  /api/v1/engine-management/inventory?{scope query}` → `{ entries }`
 * - `POST /api/v1/engine-management/operations` with `{ scope, operation }`
 *   body → `{ ack }`
 *
 * where the scope query is `scope=local` or `scope=runner&runnerId=<id>`.
 * Both routes back onto `EngineManager`
 * (`apps/server/src/agents/remote/engine-manager.ts`).
 */

function scopeQuery(scope: EngineScope): string {
  const params = new URLSearchParams({ scope: scope.kind });
  if (scope.kind === "runner") params.set("runnerId", scope.runnerId);
  return params.toString();
}

export function runnerEnginesKey(scope: EngineScope) {
  return ["runner-engines", engineScopeKey(scope)] as const;
}

/** Whether an operation leaves something still running, worth polling for. */
function hasPendingWork(entries: EngineInventoryEntry[] | undefined): boolean {
  // Sign-in is the only state this inventory can't settle on its own; an
  // install/update's completion is the inventory's own version/installed
  // change, so no separate "pending" flag is needed here.
  return (
    entries?.some((entry) => entry.signedIn === null && entry.installed) ??
    false
  );
}

export function useRunnerEngineInventory(scope: EngineScope) {
  return useQuery<{ entries: EngineInventoryEntry[] }>({
    queryKey: runnerEnginesKey(scope),
    queryFn: () =>
      api(`/api/v1/engine-management/inventory?${scopeQuery(scope)}`),
    refetchInterval: (query) =>
      hasPendingWork(query.state.data?.entries) ? 2_000 : 10_000,
  });
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
    },
  });
}
