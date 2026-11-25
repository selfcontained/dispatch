import {
  isEngineCapabilityOperation,
  type EngineCapabilityOperation,
  type EngineCapabilityResult,
  type EngineOperation,
  type EngineOperationAck,
  type EngineOperationEvent,
} from "@dispatch/runner-protocol/engine-management";
export type CapabilityParser = (
  operation: EngineCapabilityOperation,
  input: unknown
) => EngineCapabilityResult | null;

export function enrolledEngineAck(
  operation: EngineOperation,
  value: unknown,
  channel: import("node:stream").Readable | null | undefined,
  onEvent: ((event: EngineOperationEvent) => void) | undefined,
  parseEngineCapabilityResult: CapabilityParser
): EngineOperationAck {
  try {
    let buffer = "";
    let chunk: Buffer | null;
    // The channel is handed back only once the whole round trip
    // settled, so every progress frame the runner sent is already
    // sitting in its paused-mode buffer — drain it synchronously
    // rather than racing a "data" listener against stream teardown.
    while (channel && (chunk = channel.read() as Buffer | null) !== null) {
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
    if (!isEngineCapabilityOperation(operation)) return ack;
    if (ack.ok === true) {
      const capability = parseEngineCapabilityResult(operation, ack.capability);
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
}
