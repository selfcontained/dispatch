import { readStoredModelCatalog } from "../../src/shared/agent-models.js";
import { createRunnerUsage } from "../../src/agents/codex-reset.js";
import { engineScopeKey } from "@dispatch/runner-protocol/engine-management";
/** Legacy wire fixtures projected into the current engine-call dependency. */
import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import type { EngineCalls } from "../../src/runners/local.js";
import type { EngineManager } from "../../src/agents/remote/engine-manager.js";

import type {
  EngineOperation,
  EngineOperationAck,
  EngineOperationEvent,
  EngineInventoryEntry,
} from "@dispatch/runner-protocol/engine-management";
/** What a runner's connection exposes for engine management; supplied by the caller. */
export interface RunnerEngineTransport {
  /**
   * Send one operation to the named runner. `onEvent` receives any
   * progress frames the runner streams before its ack. Reject (or resolve
   * `{ ok: false, unsupported: true }`) for an offline runner or one that
   * predates engine management.
   */
  send(
    runnerId: string,
    operation: EngineOperation,
    onEvent?: (event: EngineOperationEvent) => void
  ): Promise<EngineOperationAck>;
  /**
   * The runner's last pushed inventory snapshot, if any — a cheap read
   * that skips a wire round trip. `inventory()` falls back to `send` with
   * a `"status"` operation when this is absent (not yet pushed, or the
   * transport doesn't track a cache).
   */
  cachedInventory?(runnerId: string): EngineInventoryEntry[] | undefined;
  /**
   * The last inventory from any connection: what to show while the runner
   * can't be read, as during its update.
   */
  lastKnownInventory?(runnerId: string): EngineInventoryEntry[] | undefined;
}

export type FixtureEngineDeps = Omit<
  ConstructorParameters<typeof EngineManager>[0],
  "engineActions"
> & { remote: RunnerEngineTransport };

export function fixtureEngineActions(
  deps: FixtureEngineDeps
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
    calls: (scope, liveInventory) => {
      if (scope.kind === "local") return deps.local.engines;
      return {
        call: async (op, request) => {
          if (op.startsWith("engine.login.")) {
            const { engine, loginId, code, restart } = request as {
              engine: "claude" | "codex" | "opencode";
              loginId: string;
              code: string;
              restart?: boolean;
            };
            const operation: EngineOperation =
              op === "engine.login.start"
                ? { type: "login_start", engine, restart }
                : op === "engine.login.submit"
                  ? { type: "login_submit", loginId, code }
                  : op === "engine.login.cancel"
                    ? { type: "login_cancel", loginId }
                    : { type: "login_status", loginId };
            const ack = await deps.remote.send(
              scope.runnerId,
              operation,
              undefined
            );
            if (!ack.ok)
              throw new RunnerCallError({ code: "failed", message: ack.error });
            return ack.login as never;
          }
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
            if (liveInventory)
              throw new RunnerCallError({
                code: "unavailable",
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
