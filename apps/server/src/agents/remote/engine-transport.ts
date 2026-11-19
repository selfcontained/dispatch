import type { EngineOperationAck, EngineOperationEvent } from "./protocol.js";
import {
  RunnerCapabilityUnavailable,
  type RemoteRunnerService,
} from "./service.js";
import type { RunnerEngineTransport } from "./engine-manager.js";

export function remoteEngineTransport(
  service: RemoteRunnerService
): RunnerEngineTransport {
  return {
    cachedInventory(runnerId) {
      return service.engineInventorySnapshot(runnerId);
    },
    async send(runnerId, operation, onEvent) {
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
          return JSON.parse(value) as EngineOperationAck;
        } catch {
          return { ok: false, error: "Malformed response from the runner." };
        }
      } catch (error) {
        if (error instanceof RunnerCapabilityUnavailable) {
          return { ok: false, error: error.message, unsupported: true };
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
