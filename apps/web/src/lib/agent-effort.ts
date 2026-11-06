import type { Effort } from "@dispatch/shared";
import type { AgentType } from "./agent-types";

/** Check the resolved template/override value without changing null inheritance. */
export function effortCompatibilityError(
  agentType: AgentType,
  effort: Effort | null | undefined
): string | null {
  if (effort == null) return null;
  if (agentType === "opencode") {
    return `OpenCode does not support ${effort} effort. Choose another agent type or a template without effort.`;
  }
  if (agentType === "codex" && effort === "max") {
    return "Codex does not support max effort. Choose low, medium, high or xhigh, or another agent type.";
  }
  return null;
}
