import { EFFORT_LEVELS, type AgentType, type Effort } from "@dispatch/shared";

export function validateAgentEffort(
  type: AgentType,
  effort: unknown
): Effort | null {
  if (effort === undefined || effort === null) return null;
  if (typeof effort !== "string" || !EFFORT_LEVELS.includes(effort as Effort)) {
    throw new Error(
      `Invalid effort "${String(effort)}". Use low, medium, high, xhigh, max, or null to inherit.`
    );
  }
  if (type === "opencode")
    throw new Error(
      "OpenCode does not support launch effort. Remove effort from the template or launch configuration, or choose Claude/Codex."
    );
  if (type === "codex" && effort === "max")
    throw new Error(
      "Codex does not support effort max. Use low, medium, high, or xhigh (subject to model support)."
    );
  return effort as Effort;
}
