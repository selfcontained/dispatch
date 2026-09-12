import { HARNESS_ENGINE_IDS, harnessEngineOf } from "@dispatch/shared";

import { CLI_AGENT_TYPES, type AgentType } from "./agent-types.js";

export type AgentModelOption = {
  id: string;
  label: string;
  /** Section header in grouped pickers (the provider), when known. */
  group?: string;
};

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
 * - Claude Code: https://code.claude.com/docs/en/cli-usage
 *
 * See docs/agent-model-catalog.md for the update procedure.
 */
export const AGENT_MODEL_OPTIONS: Partial<
  Record<AgentType, readonly AgentModelOption[]>
> = {
  codex: [
    { id: "gpt-6-astra", label: "GPT-6 Astra" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    { id: "gpt-5.5", label: "GPT-5.5" },
    // Research preview: listed in the per-account remote catalog but not yet
    // in the CLI's embedded registry, so it may not exist for every account.
    { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark (preview)" },
  ],
  // Claude Code documents these moving aliases for its latest models.
  claude: [
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
    { id: "haiku", label: "Haiku" },
    { id: "fable", label: "Fable" },
  ],
  // Dispatch Harness ids are `engine/model`. The engine picks the ACP agent;
  // the model half is what that engine calls it, or `default` for the
  // engine's own default. The picker inside a running session reads the
  // engine's live options; this list is for the create dialog.
  dispatch: [
    {
      id: "claude/default",
      label: "Claude Code default",
      group: "Claude Code",
    },
    { id: "claude/claude-fable-5-1", label: "Fable 5.1", group: "Claude Code" },
    { id: "claude/claude-opus-5", label: "Opus 5", group: "Claude Code" },
    { id: "claude/claude-sonnet-5", label: "Sonnet 5", group: "Claude Code" },
    {
      id: "claude/claude-haiku-4-5-20251001",
      label: "Haiku 4.5",
      group: "Claude Code",
    },
    { id: "codex/default", label: "Codex default", group: "Codex" },
    { id: "codex/gpt-6-astra", label: "GPT-6 Astra", group: "Codex" },
    { id: "codex/gpt-5.6-sol", label: "GPT-5.6 Sol", group: "Codex" },
    { id: "codex/gpt-5.6-terra", label: "GPT-5.6 Terra", group: "Codex" },
    { id: "codex/gpt-5.6-luna", label: "GPT-5.6 Luna", group: "Codex" },
    { id: "codex/gpt-5.5", label: "GPT-5.5", group: "Codex" },
    {
      id: "codex/gpt-5.3-codex-spark",
      label: "GPT-5.3 Codex Spark (preview)",
      group: "Codex",
    },
    {
      id: "gemini/default",
      label: "Gemini CLI default (gemini-2.5-pro)",
      group: "Gemini CLI",
    },
    {
      id: "gemini/gemini-3-pro-preview",
      label: "Gemini 3 Pro (preview)",
      group: "Gemini CLI",
    },
    {
      id: "gemini/gemini-3-flash-preview",
      label: "Gemini 3 Flash (preview)",
      group: "Gemini CLI",
    },
    {
      id: "gemini/gemini-3.5-flash",
      label: "Gemini 3.5 Flash",
      group: "Gemini CLI",
    },
    {
      id: "gemini/gemini-2.5-pro",
      label: "Gemini 2.5 Pro",
      group: "Gemini CLI",
    },
    {
      id: "gemini/gemini-2.5-flash",
      label: "Gemini 2.5 Flash",
      group: "Gemini CLI",
    },
    { id: "opencode/default", label: "OpenCode default", group: "OpenCode" },
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
 * Keeps a label's trailing qualifier — "GPT-5.3 Codex Spark (preview)" renders
 * as "gpt-5.3-codex-spark (preview)". The catalog marks risky ids only in their
 * labels, so dropping them would advertise a preview id as an equal of a stable
 * one to every agent reading the tool description.
 */
function describeOption(option: AgentModelOption): string {
  const qualifier = /\(([^)]*)\)\s*$/.exec(option.label)?.[1];
  return qualifier ? `${option.id} (${qualifier})` : option.id;
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
    supported.push(`${agentType}: ${options.map(describeOption).join(", ")}`);
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

/**
 * The model half of a harness id. Slashes are allowed after the first one
 * because OpenCode ids are `provider/model`, which is also the shape
 * `HarnessSupervisor.setConfigOption` persists when a model is switched at
 * runtime; a stricter rule here rejected the supervisor's own stored value
 * the next time a job or template update path validated it.
 */
const HARNESS_MODEL_HALF = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

/**
 * Split a harness model id the way `splitModelId` does at start time, so a
 * typo is a 400 at create rather than "unknown engine" in the sidebar once
 * the agent is already there. The engine catalog itself is the engine's, so
 * the model half is only shape-checked.
 */
function validateHarnessModel(model: string): string {
  const slash = model.indexOf("/");
  const engine = slash > 0 ? model.slice(0, slash) : "";
  const rest = slash > 0 ? model.slice(slash + 1) : "";
  const known = (HARNESS_ENGINE_IDS as readonly string[]).includes(engine);
  if (!known || !HARNESS_MODEL_HALF.test(rest)) {
    throw new Error(
      `Model "${model}" is not a harness model id. Use engine/model, where engine is one of ${HARNESS_ENGINE_IDS.join(", ")}, for example codex/gpt-5.6-sol.`
    );
  }
  return model;
}

export function validateAgentModel(
  agentType: AgentType,
  model: string | undefined
): string | undefined {
  const normalizedModel = model?.trim() || undefined;
  if (normalizedModel === undefined) return undefined;
  if (agentType === "dispatch") return validateHarnessModel(normalizedModel);
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

/**
 * The model a child or persona of type `dispatch` runs with when the caller
 * named none.
 *
 * A harness agent's engine is the first segment of its model id, so a child
 * that runs as its parent's own kind has to carry the parent's engine as
 * well: left to the supervisor's own default, a Codex- or Gemini-harness
 * parent's reviewer runs on Claude Code, which is both the wrong reasoning
 * and the wrong account to bill. Returns undefined for anything else, which
 * leaves the CLI default in place.
 */
export function inheritedHarnessModel(
  agentType: AgentType,
  parent: { type?: string | null; model?: string | null }
): string | undefined {
  if (agentType !== "dispatch" || parent.type !== "dispatch") return undefined;
  const engine = harnessEngineOf(parent.model);
  if (!engine) return undefined;
  return parent.model || `${engine.id}/default`;
}

/** The agent-config fields every job/template create path defaults the same way. */
export type AgentConfigInput<T extends AgentType = AgentType> = {
  agentType?: T;
  model?: string | null;
  useWorktree?: boolean;
  baseBranch?: string | null;
  branchName?: string | null;
  fullAccess?: boolean;
};

export type AgentConfigDefaults<T extends AgentType = AgentType> = {
  agentType: T | "claude";
  model: string | null;
  useWorktree: boolean;
  baseBranch: string | null;
  branchName: string | null;
  fullAccess: boolean;
};

/**
 * Normalizes the agent-config half of a create payload: agent type falls back
 * to claude, the model is validated against that type, and the worktree /
 * access flags take their stored defaults.
 *
 * Shared by the jobs and templates create paths, which write the same six
 * columns from the same optional inputs. Throws when the model is not in the
 * resolved agent type's catalog, exactly as validateAgentModel does.
 */
export function applyAgentConfigDefaults<T extends AgentType = AgentType>(
  input: AgentConfigInput<T>
): AgentConfigDefaults<T> {
  const agentType = input.agentType ?? "claude";
  return {
    agentType,
    model: validateAgentModel(agentType, input.model ?? undefined) ?? null,
    useWorktree: input.useWorktree ?? false,
    baseBranch: input.baseBranch ?? null,
    branchName: input.branchName ?? null,
    fullAccess: input.fullAccess ?? false,
  };
}

/**
 * Resolves the model an update should store.
 *
 * An explicit model in the payload is validated against the agent type the
 * record will end up with. Otherwise a stored model that the new agent type no
 * longer offers is dropped, so switching agent type never leaves an
 * incompatible model behind. Shared by the jobs and templates update paths.
 */
export function resolveAgentModelForUpdate(params: {
  inputAgentType: AgentType | undefined;
  inputModel: string | null | undefined;
  existingAgentType: AgentType;
  existingModel: string | null;
}): string | null {
  const nextAgentType = params.inputAgentType ?? params.existingAgentType;
  if (params.inputModel !== undefined) {
    return (
      validateAgentModel(nextAgentType, params.inputModel ?? undefined) ?? null
    );
  }
  if (
    params.inputAgentType !== undefined &&
    params.existingModel !== null &&
    !getAgentModelOptions(nextAgentType).some(
      (option) => option.id === params.existingModel
    )
  ) {
    return null;
  }
  return params.existingModel;
}
