import type { AgentType } from "./agent-types.js";

export type AgentModelOption = { id: string; label: string };

/**
 * Source-controlled model catalog for the launchers Dispatch supports.
 *
 * Maintenance sources (review before changing this catalog):
 * - Codex: https://learn.chatgpt.com/docs/models.md
 * - Claude Code: https://docs.anthropic.com/en/docs/claude-code/cli-usage
 * - Cursor Agent: https://docs.cursor.com/en/cli/reference/parameters
 * - Cursor models: https://docs.cursor.com/models/
 *
 * See docs/agent-model-catalog.md for the update procedure.
 */
export const AGENT_MODEL_OPTIONS: Partial<
  Record<AgentType, readonly AgentModelOption[]>
> = {
  codex: [
    { id: "gpt-5.6", label: "GPT-5.6 (Sol alias)" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 mini" },
    { id: "gpt-5.4-nano", label: "GPT-5.4 nano" },
    { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  ],
  // Claude Code documents these moving aliases for its latest models.
  claude: [
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
    { id: "haiku", label: "Haiku" },
    { id: "claude-fable-5", label: "Fable 5" },
  ],
  cursor: [
    { id: "auto", label: "Auto" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "claude-opus-4.6", label: "Claude Opus 4.6" },
    { id: "gemini-3-pro", label: "Gemini 3 Pro" },
  ],
};

export function getAgentModelOptions(
  agentType: AgentType
): readonly AgentModelOption[] {
  return AGENT_MODEL_OPTIONS[agentType] ?? [];
}

export function validateAgentModel(
  agentType: AgentType,
  model: string | undefined
): string | undefined {
  const normalizedModel = model?.trim() || undefined;
  if (normalizedModel === undefined) return undefined;
  if (
    getAgentModelOptions(agentType).some(
      (option) => option.id === normalizedModel
    )
  ) {
    return normalizedModel;
  }
  throw new Error(
    `Model "${normalizedModel}" is not supported for ${agentType}. Choose a configured model or omit model for the CLI default.`
  );
}
