import { CLI_AGENT_TYPES, type AgentType } from "./agent-types.js";

export type AgentModelOption = { id: string; label: string };

/**
 * Source-controlled model catalog for the launchers Dispatch supports.
 *
 * Agent types absent from this map (currently cursor and opencode) hide the
 * model picker and always launch with the CLI default.
 *
 * Every entry must be cross-checked against the installed CLI's own model
 * registry before it ships — provider doc prose alone is not evidence a slug
 * exists. See docs/agent-model-catalog.md for the per-CLI procedure and the
 * evidence bar. Cursor has no entry because no list has passed that bar yet
 * (its docs carry display names rather than CLI slugs, and a logged-out
 * `cursor-agent` reports no models); to add one, use the exact slugs from
 * `cursor-agent --list-models` on the logged-in account Dispatch runs under.
 *
 * Maintenance sources:
 * - Codex: https://learn.chatgpt.com/docs/models.md
 * - Claude Code: https://docs.anthropic.com/en/docs/claude-code/cli-usage
 *
 * See docs/agent-model-catalog.md for the update procedure.
 */
export const AGENT_MODEL_OPTIONS: Partial<
  Record<AgentType, readonly AgentModelOption[]>
> = {
  codex: [
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    { id: "gpt-5.5", label: "GPT-5.5" },
    // gpt-5.4 and gpt-5.4-mini retire 2026-08-31 (successors: terra, luna) —
    // tracked in docs/agent-model-catalog.md § Known upcoming retirements.
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 mini" },
    // Research preview: listed in the per-account remote catalog but not yet
    // in the CLI's embedded registry, so it may not exist for every account.
    { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark (preview)" },
  ],
  // Claude Code documents these moving aliases for its latest models.
  claude: [
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
    { id: "haiku", label: "Haiku" },
    { id: "claude-fable-5", label: "Fable 5" },
  ],
};

export function getAgentModelOptions(
  agentType: AgentType
): readonly AgentModelOption[] {
  return AGENT_MODEL_OPTIONS[agentType] ?? [];
}

function joinWithAnd(values: readonly string[]): string {
  if (values.length <= 2) return values.join(" and ");
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

/**
 * Renders the catalog as a one-line summary for MCP tool schemas.
 *
 * Agents launching other agents over MCP have no other way to discover which
 * model ids a given agent type accepts, and an unsupported id is rejected at
 * launch — so the allowlist ships inside the `model` parameter description.
 *
 * Pass the agent types the calling tool actually accepts: template tools also
 * take `terminal`, which has no catalog entry, and naming it as unsupported is
 * what keeps the description honest about the ids that tool will take.
 */
export function describeAgentModelCatalog(
  agentTypes: readonly AgentType[] = CLI_AGENT_TYPES
): string {
  const supported: string[] = [];
  const unsupported: string[] = [];

  for (const agentType of agentTypes) {
    const options = getAgentModelOptions(agentType);
    if (options.length === 0) {
      unsupported.push(agentType);
      continue;
    }
    supported.push(
      `${agentType}: ${options.map((option) => option.id).join(", ")}`
    );
  }

  const sentences =
    supported.length > 0
      ? [`Supported ids by agent type — ${supported.join("; ")}.`]
      : [];
  if (unsupported.length > 0) {
    sentences.push(
      `${joinWithAnd(unsupported)} accept${unsupported.length === 1 ? "s" : ""} no model override — omit model for ${unsupported.length === 1 ? "that" : "those"}.`
    );
  }
  return sentences.join(" ");
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
