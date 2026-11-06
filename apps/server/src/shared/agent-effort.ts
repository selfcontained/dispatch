import type { AgentType, Effort } from "@dispatch/shared";
import { getAgentModelOptions, agentModelDefaults } from "./agent-models.js";

/** Stored settings remain forward-compatible; the live engine validates at launch. */
export function validateAgentEffort(
  type: AgentType,
  effort: unknown,
  model?: string | null
): Effort | null {
  if (effort == null) return null;
  if (typeof effort !== "string" || !effort.trim() || effort.length > 128) {
    throw new Error(
      "Invalid effort. Choose an engine-reported level or null to inherit."
    );
  }
  model ??= agentModelDefaults()[type];
  const choices = model
    ? getAgentModelOptions(type).find((option) => option.id === model)?.effort
    : undefined;
  if (choices && !choices.some((choice) => choice.value === effort)) {
    throw new Error(
      `Effort "${effort}" is not supported for this model. Choose a reported level or Default.`
    );
  }
  return effort;
}
