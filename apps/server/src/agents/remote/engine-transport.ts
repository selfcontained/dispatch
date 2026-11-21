import { isEngineCapabilityOperation } from "@dispatch/runner-protocol/engine-management";
import { parseEngineCapabilityResult } from "./engine-capability-result.js";
import type { EngineOperationAck, EngineOperationEvent } from "./protocol.js";
import {
  RunnerCapabilityUnavailable,
  RunnerUnavailable,
  type RemoteRunnerService,
} from "./service.js";
import type { RunnerEngineTransport } from "./engine-manager.js";
import type { RunnerEngine } from "@dispatch/runner-protocol";
import type { AgentType } from "../../shared/agent-types.js";
import type { RunnerModelCatalogSource } from "../../shared/agent-models.js";

export function remoteEngineTransport(
  service: RemoteRunnerService
): RunnerEngineTransport {
  return {
    cachedInventory(runnerId) {
      return service.engineInventorySnapshot(runnerId);
    },
    async send(runnerId, operation, onEvent) {
      const scoped = isEngineCapabilityOperation(operation);
      try {
        const { value, channel } = await service.requestRunner(runnerId, {
          kind: "engine",
          operation,
        });
        try {
          let buffer = "";
          let chunk: Buffer | null;
          // The channel is handed back only once the whole round trip
          // settled, so every progress frame the runner sent is already
          // sitting in its paused-mode buffer — drain it synchronously
          // rather than racing a "data" listener against stream teardown.
          while (
            channel &&
            (chunk = channel.read() as Buffer | null) !== null
          ) {
            buffer += chunk.toString("utf8");
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              if (!line) continue;
              try {
                onEvent?.(JSON.parse(line) as EngineOperationEvent);
              } catch {
                /* a malformed progress line is not fatal to the operation */
              }
            }
          }
        } finally {
          channel?.destroy();
        }
        if (typeof value !== "string") {
          return { ok: false, error: "No response from the runner." };
        }
        try {
          const ack = JSON.parse(value) as EngineOperationAck;
          if (!scoped) return ack;
          if (ack.ok === true) {
            const capability = parseEngineCapabilityResult(
              operation,
              ack.capability
            );
            if (capability) return { ok: true, capability };
          }
          if (ack.ok === false && ack.unsupported === true) {
            return {
              ok: false,
              unsupported: true,
              error: "This engine action is unavailable on the runner.",
            };
          }
          if (operation.type === "codex_reset") {
            if (ack.ok === false && ack.reason === "account_changed") {
              return {
                ok: false,
                reason: "account_changed",
                error:
                  "The Codex account changed. Refresh usage before trying again.",
              };
            }
            return {
              ok: false,
              error:
                "The runner did not confirm the reset. Refresh usage before trying again.",
            };
          }
          return {
            ok: false,
            error: "Could not complete the engine request on this runner.",
          };
        } catch {
          return { ok: false, error: "Malformed response from the runner." };
        }
      } catch (error) {
        if (error instanceof RunnerCapabilityUnavailable) {
          return { ok: false, error: error.message, unsupported: true };
        }
        if (scoped) {
          return {
            ok: false,
            error:
              error instanceof RunnerUnavailable
                ? "The runner is disconnected or unavailable."
                : "Could not complete the engine request on this runner.",
          };
        }
        return {
          ok: false,
          error:
            error instanceof Error ? error.message : "Runner request failed.",
        };
      }
    },
  };
}

const RUNNER_ENGINES: readonly AgentType[] = ["claude", "codex", "opencode"];

/**
 * A runner's model catalog for one engine, read through the existing
 * `model_catalog` engine operation. Null when the runner is offline, too
 * old, or has nothing to report for that engine.
 */
export function runnerModelCatalogSource(
  transport: RunnerEngineTransport
): RunnerModelCatalogSource {
  return async (runnerId, agentType) => {
    if (!RUNNER_ENGINES.includes(agentType)) return null;
    const ack = await transport.send(runnerId, {
      type: "model_catalog",
      engine: agentType as RunnerEngine,
    });
    return ack.ok && ack.capability?.type === "model_catalog"
      ? ack.capability.catalog
      : null;
  };
}
