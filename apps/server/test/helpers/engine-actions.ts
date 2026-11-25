import { readStoredModelCatalog } from "../../src/shared/agent-models.js";
import { createRunnerUsage } from "../../src/agents/codex-reset.js";
import { engineScopeKey } from "@dispatch/runner-protocol/engine-management";
/** Legacy wire fixtures projected into the current engine-call dependency. */
import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import type { EngineCalls } from "../../src/runners/local.js";
import type { EngineManager } from "../../src/agents/remote/engine-manager.js";

export function fixtureEngineActions(
  deps: Omit<ConstructorParameters<typeof EngineManager>[0], "engineActions">
): ConstructorParameters<typeof EngineManager>[0]["engineActions"] {
  const coordinators = new Map<string, ReturnType<typeof createRunnerUsage>>();
  const actions: ConstructorParameters<
    typeof EngineManager
  >[0]["engineActions"] = {
    models: (scope, engine, model) =>
      readStoredModelCatalog(
        scope.kind === "local" ? "local" : scope.runnerId,
        engine,
        model
      ),
    usage(scope) {
      const key = engineScopeKey(scope);
      let usage = coordinators.get(key);
      if (!usage) {
        usage = createRunnerUsage(actions.calls(scope));
        coordinators.set(key, usage);
      }
      return usage;
    },
    updates: () => deps.local.updates,
    calls: (scope) => {
      if (scope.kind === "local") return deps.local.engines;
      return {
        call: async (op, request) => {
          if (op !== "engine.list")
            throw new Error(`Unexpected fixture call ${op}`);
          if (!(request as { refresh: boolean }).refresh) {
            const cached = deps.remote.cachedInventory?.(scope.runnerId);
            if (cached) return { entries: cached } as never;
          }
          let entries: unknown[] = [];
          const ack = await deps.remote.send(
            scope.runnerId,
            { type: "status" },
            (event) => {
              if (event.type === "inventory") entries = event.entries;
            }
          );
          if (!ack.ok) {
            if (ack.unsupported)
              throw new RunnerCallError({
                code: "unsupported",
                message: ack.error,
              });
            const last = deps.remote.lastKnownInventory?.(scope.runnerId);
            return {
              entries: last?.map((entry) => ({ ...entry, actions: [] })) ?? [],
              available: last !== undefined,
            } as never;
          }
          return { entries } as never;
        },
      } as EngineCalls;
    },
  };
  return actions;
}
