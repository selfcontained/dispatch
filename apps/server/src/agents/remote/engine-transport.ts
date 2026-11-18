import {
  MANAGED_WORKSPACE,
  type EngineOperationAck,
  type EngineOperationEvent,
} from "./protocol.js";
import { RunnerUnavailable, type RemoteRunnerService } from "./service.js";
import type { RunnerEngineTransport } from "./engine-manager.js";

/**
 * `RunnerEngineTransport` backed by the live runner wire connection: sends
 * an `"engine"` command through `RemoteRunnerService.request`, which opens
 * a channel for progress (`data` frames, NDJSON `EngineOperationEvent`
 * lines) alongside the terminal `result` frame carrying the JSON-encoded
 * ack. A runner that predates engine management never answers the
 * command, surfacing as `unsupported`.
 */
export function remoteEngineTransport(
  service: RemoteRunnerService
): RunnerEngineTransport {
  return {
    cachedInventory(runnerId) {
      return service.engineInventorySnapshot(runnerId);
    },
    async send(runnerId, operation, onEvent) {
      // Engine management is runner-wide, not per-workspace; the wire
      // Command still needs *a* workspace for routing, and every runner
      // built for this always advertises MANAGED_WORKSPACE.
      const placement = { runner: runnerId, workspace: MANAGED_WORKSPACE };
      if (!service.available(placement)) {
        return {
          ok: false,
          error: "The runner is disconnected or unavailable.",
          unsupported: true,
        };
      }
      try {
        const { value, channel } = await service.request(
          placement,
          // Engine commands aren't bound to any agent; the id is a fixed,
          // opaque placeholder the runner's "engine" branch never checks.
          {
            agentId: "@engine",
            workspace: MANAGED_WORKSPACE,
            kind: "engine",
            operation,
          },
          true
        );
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
        if (error instanceof RunnerUnavailable) {
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
