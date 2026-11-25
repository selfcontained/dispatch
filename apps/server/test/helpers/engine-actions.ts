/** Legacy wire fixtures projected into the current engine-call dependency. */
import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import type { EngineCalls } from "../../src/runners/local.js";
import type { EngineManager } from "../../src/agents/remote/engine-manager.js";

export function fixtureEngineActions(
  deps: Omit<ConstructorParameters<typeof EngineManager>[0], "engineActions">
): ConstructorParameters<typeof EngineManager>[0]["engineActions"] {
  return {
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
}
