import type { AgentType, Effort } from "@dispatch/shared";
import {
  agentModelDefaults,
  LOCAL_MODEL_SCOPE,
  scopeModelOptions,
  type ModelScope,
} from "./agent-models.js";

/**
 * Checks effort against the scope's reported levels for the model (or the
 * scope's default model). Stored settings remain forward-compatible: a model
 * whose levels were never reported accepts any level, and the live engine
 * validates at launch.
 */
export function validateAgentEffort(
  type: AgentType,
  effort: unknown,
  model?: string | null,
  scope: ModelScope = LOCAL_MODEL_SCOPE
): Effort | null {
  if (effort == null) return null;
  if (typeof effort !== "string" || !effort.trim() || effort.length > 128) {
    throw new Error(
      "Invalid effort. Choose an engine-reported level or null to inherit."
    );
  }
  const options = scopeModelOptions(type, scope);
  if (options === null) return effort;
  model ??=
    scope.kind === "runner"
      ? (scope.defaultModel ?? undefined)
      : agentModelDefaults()[type];
  const choices = model
    ? options.find((option) => option.id === model)?.effort
    : undefined;
  if (choices && !choices.some((choice) => choice.value === effort)) {
    throw new Error(
      `Effort "${effort}" is not supported for this model. Choose a reported level or Default.`
    );
  }
  return effort;
}
