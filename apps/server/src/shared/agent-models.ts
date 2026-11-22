import { CLI_AGENT_TYPES, type AgentType } from "./agent-types.js";

export type AgentModelOption = {
  id: string;
  label: string;
  /** Absent until observed; empty means unsupported. */ effort?: import("@dispatch/shared").AgentConfigChoice[];
};
const learnedDefaults = new Map<AgentType, string>();
export function agentModelDefaults(): Partial<Record<AgentType, string>> {
  return Object.fromEntries(learnedDefaults);
}

/**
 * Seed model catalog for the launchers Dispatch supports: what the picker
 * offers before an engine has run here. Once one has, the list it published
 * over ACP takes over (see setLearnedAgentModels).
 *
 * Agent types absent from this map hide the
 * model picker and always launch with the CLI default.
 *
 * Every entry must be cross-checked against the installed CLI's own model
 * registry before it ships — provider doc prose alone is not evidence a slug
 * exists. See docs/agent-model-catalog.md for the per-CLI procedure and the
 * evidence bar.
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
    // Remote catalog cache only as of 2026-09-22; not yet in the embedded
    // fallback registry, so may not be available to every account.
    { id: "gpt-6-sol", label: "GPT-6 Sol (preview)" },
    { id: "gpt-6-luna", label: "GPT-6 Luna (preview)" },
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
};

/**
 * What each engine said it could run, the last time one of its sessions
 * opened on this machine. Learned lists replace the seed above for their
 * type: they are the engine's own words, for this install and this login.
 */
const learned = new Map<AgentType, readonly AgentModelOption[]>();

export function setLearnedAgentModels(
  agentType: AgentType,
  options: readonly AgentModelOption[],
  defaultModel?: string
): void {
  if (options.length === 0) return;
  if (defaultModel) learnedDefaults.set(agentType, defaultModel);
  learned.set(
    agentType,
    options.map((o) => ({ ...o }))
  );
}

/** Tests reset what earlier tests taught. */
export function forgetLearnedAgentModels(): void {
  learned.clear();
  learnedDefaults.clear();
  availability.clear();
}

export function getLearnedAgentModels(
  agentType: AgentType
): readonly AgentModelOption[] | undefined {
  return learned.get(agentType);
}

/**
 * Which of a type's models are offered for new choices. It is only a filter:
 * the catalog, Default and launches of saved choices do not read it. Stored
 * and changed through agents/model-availability.ts.
 */
export type AgentModelAvailability = {
  /** Whether a model the engine lists for the first time starts on. */
  autoEnable: boolean;
  disabled: readonly string[];
  /** New models the person has not seen in a list yet. */
  unseen: readonly string[];
  /** Every id the engine has ever listed; null before its first list. */
  known: readonly string[] | null;
};
const availability = new Map<AgentType, AgentModelAvailability>();

export function setAgentModelAvailability(
  agentType: AgentType,
  value: AgentModelAvailability
): void {
  availability.set(agentType, value);
}

export function getAgentModelAvailability(
  agentType: AgentType
): AgentModelAvailability {
  return (
    availability.get(agentType) ?? {
      autoEnable: true,
      disabled: [],
      unseen: [],
      known: null,
    }
  );
}

/** The filter as the pickers and Settings read it. */
export function agentModelAvailability(): Partial<
  Record<AgentType, Omit<AgentModelAvailability, "known">>
> {
  return Object.fromEntries(
    CLI_AGENT_TYPES.map((agentType) => {
      const { known: _known, ...shown } = getAgentModelAvailability(agentType);
      return [agentType, shown];
    })
  );
}

/** The catalog less what is turned off: what can be newly chosen. */
export function selectableAgentModels(
  agentType: AgentType
): readonly AgentModelOption[] {
  const { disabled } = getAgentModelAvailability(agentType);
  const options = getAgentModelOptions(agentType);
  return disabled.length
    ? options.filter((option) => !disabled.includes(option.id))
    : options;
}

export function getAgentModelOptions(
  agentType: AgentType
): readonly AgentModelOption[] {
  return learned.get(agentType) ?? AGENT_MODEL_OPTIONS[agentType] ?? [];
}

/** The catalog the pickers read: learned lists over the seed, per type. */
export function agentModelCatalog(): Partial<
  Record<AgentType, readonly AgentModelOption[]>
> {
  const catalog: Partial<Record<AgentType, readonly AgentModelOption[]>> = {
    ...AGENT_MODEL_OPTIONS,
  };
  for (const [agentType, options] of learned) catalog[agentType] = options;
  return catalog;
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
 * Renders the selectable catalog as a one-line summary for MCP tool schemas.
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
    const options = selectableAgentModels(agentType);
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

/** Throws when `model` is turned off and is not the choice already saved. */
export function assertModelSelectable(
  agentType: AgentType,
  model: string | null | undefined,
  saved?: string | null
): void {
  if (!model || model === saved) return;
  if (!getAgentModelAvailability(agentType).disabled.includes(model)) return;
  const on = selectableAgentModels(agentType).map(({ id }) => id);
  throw new Error(
    `Model "${model}" is turned off for ${agentType} in Settings → Agents. ` +
      (on.length
        ? `Choose one of ${on.join(", ")}, or omit model for the CLI default.`
        : "Omit model for the CLI default.")
  );
}

/**
 * Validates a model somebody is choosing now. Launching something saved uses
 * validateAgentModel alone, so it keeps running after its model is turned off.
 * `saved` is the value being edited, which may be sent back unchanged.
 */
export function validateAgentModelChoice(
  agentType: AgentType,
  model: string | undefined,
  saved?: string | null
): string | undefined {
  const valid = validateAgentModel(agentType, model);
  assertModelSelectable(agentType, valid, saved);
  return valid;
}

/** The agent-config fields every job/template create path defaults the same way. */
export type AgentConfigInput<T extends AgentType = AgentType> = {
  agentType?: T;
  model?: string | null;
  persona?: string | null;
  useWorktree?: boolean;
  baseBranch?: string | null;
  branchName?: string | null;
  fullAccess?: boolean;
};

export type AgentConfigDefaults<T extends AgentType = AgentType> = {
  agentType: T | "claude";
  model: string | null;
  persona?: string | null;
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
 * resolved agent type's catalog or is turned off.
 */
export function applyAgentConfigDefaults<T extends AgentType = AgentType>(
  input: AgentConfigInput<T>
): AgentConfigDefaults<T> {
  const agentType = input.agentType ?? "claude";
  return {
    agentType,
    ...(input.persona !== undefined ? { persona: input.persona } : {}),
    model:
      validateAgentModelChoice(agentType, input.model ?? undefined) ?? null,
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
 * incompatible model behind. A stored model that was turned off stays, as
 * long as the type does. Shared by the jobs and templates update paths.
 */
export function resolveAgentModelForUpdate(params: {
  inputAgentType: AgentType | undefined;
  inputModel: string | null | undefined;
  existingAgentType: AgentType;
  existingModel: string | null;
}): string | null {
  const nextAgentType = params.inputAgentType ?? params.existingAgentType;
  const sameType = nextAgentType === params.existingAgentType;
  if (params.inputModel !== undefined) {
    return (
      validateAgentModelChoice(
        nextAgentType,
        params.inputModel ?? undefined,
        sameType ? params.existingModel : null
      ) ?? null
    );
  }
  if (
    params.inputAgentType !== undefined &&
    params.existingModel !== null &&
    !(
      sameType
        ? getAgentModelOptions(nextAgentType)
        : selectableAgentModels(nextAgentType)
    ).some((option) => option.id === params.existingModel)
  ) {
    return null;
  }
  return params.existingModel;
}
