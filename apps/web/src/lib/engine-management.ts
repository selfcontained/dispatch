import { api } from "@/lib/api";
import type {
  EngineOperationAck,
  EngineCapabilityOperation,
  EngineCapabilityResult,
} from "@dispatch/runner-protocol/engine-management";
import type { EngineScope } from "@dispatch/runner-protocol/engine-management";
export const LOCAL_ENGINE_SCOPE: EngineScope = { kind: "local" };
export function engineScopeQuery(scope: EngineScope): string {
  const params = new URLSearchParams({ scope: scope.kind });
  if (scope.kind === "runner") params.set("runnerId", scope.runnerId);
  return params.toString();
}

export async function runnerEngineCapability<
  T extends EngineCapabilityResult["type"],
>(
  runnerId: string | EngineScope,
  operation: EngineCapabilityOperation,
  type: T
): Promise<Extract<EngineCapabilityResult, { type: T }>> {
  const { ack } = await api<{ ack: EngineOperationAck }>(
    "/api/v1/engine-management/operations",
    {
      method: "POST",
      body: JSON.stringify({
        scope:
          typeof runnerId === "string"
            ? { kind: "runner", runnerId }
            : runnerId,
        operation,
      }),
    }
  );
  if (!ack.ok) throw new Error(ack.error);
  if (ack.capability?.type !== type)
    throw new Error("The runner did not return the requested engine data.");
  return ack.capability as Extract<EngineCapabilityResult, { type: T }>;
}
