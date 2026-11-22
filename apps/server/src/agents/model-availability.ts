import type { Pool } from "pg";

import { getSetting, setSetting } from "../db/settings.js";
import {
  getAgentModelAvailability,
  getAgentModelOptions,
  getLearnedAgentModels,
  selectableAgentModels,
  setAgentModelAvailability,
  type AgentModelAvailability,
} from "../shared/agent-models.js";
import { AGENT_TYPES, type AgentType } from "../shared/agent-types.js";

/** The settings key a type's filter lives under. */
const settingKey = (agentType: AgentType) =>
  `agent_model_availability:${agentType}`;

export type ModelAvailabilityChange =
  | { autoEnable: boolean }
  | { model: string; enabled: boolean }
  | { seen: string[] };

/** A change the person can fix, as opposed to a failed write. */
export class ModelAvailabilityError extends Error {}

/**
 * Settings changes and engine reports edit the same stored value, so they
 * take turns: each reads what the one before it wrote.
 */
let queue: Promise<unknown> = Promise.resolve();

function change(
  pool: Pool,
  agentType: AgentType,
  next: (current: AgentModelAvailability) => AgentModelAvailability | null
): Promise<boolean> {
  const result = queue.then(async () => {
    const value = next(getAgentModelAvailability(agentType));
    if (!value) return false;
    await setSetting(pool, settingKey(agentType), JSON.stringify(value));
    setAgentModelAvailability(agentType, value);
    return true;
  });
  queue = result.catch(() => {});
  return result;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * At boot, after the learned lists load. An install that learned its models
 * before this setting existed takes that list as the baseline, so none of
 * them read as new.
 */
export async function loadModelAvailability(pool: Pool): Promise<void> {
  for (const agentType of AGENT_TYPES) {
    let stored: Partial<AgentModelAvailability> | null = null;
    try {
      const raw = await getSetting(pool, settingKey(agentType));
      if (raw) stored = JSON.parse(raw) as Partial<AgentModelAvailability>;
    } catch (error) {
      // A corrupt entry leaves every model on; a failed read must not.
      if (!(error instanceof SyntaxError)) throw error;
    }
    setAgentModelAvailability(agentType, {
      autoEnable: stored?.autoEnable !== false,
      disabled: strings(stored?.disabled),
      unseen: strings(stored?.unseen),
      known: Array.isArray(stored?.known)
        ? strings(stored.known)
        : (getLearnedAgentModels(agentType)?.map(({ id }) => id) ?? null),
    });
  }
}

/**
 * An engine listed its models. The first list is the baseline; an id never
 * listed before is new, and starts off when auto-enable is off. Returns
 * whether anything changed.
 */
export function recordListedModels(
  pool: Pool,
  agentType: AgentType,
  ids: readonly string[]
): Promise<boolean> {
  return change(pool, agentType, (current) => {
    const { known } = current;
    if (!known) return { ...current, known: [...ids] };
    const found = ids.filter((id) => !known.includes(id));
    if (found.length === 0) return null;
    return {
      ...current,
      known: [...known, ...found],
      unseen: [...current.unseen, ...found],
      disabled: current.autoEnable
        ? current.disabled
        : [...new Set([...current.disabled, ...found])],
    };
  });
}

export function updateModelAvailability(
  pool: Pool,
  agentType: AgentType,
  input: ModelAvailabilityChange
): Promise<boolean> {
  return change(pool, agentType, (current) => {
    if ("autoEnable" in input) {
      return input.autoEnable === current.autoEnable
        ? null
        : { ...current, autoEnable: input.autoEnable };
    }
    if ("seen" in input) {
      const unseen = current.unseen.filter((id) => !input.seen.includes(id));
      return unseen.length === current.unseen.length
        ? null
        : { ...current, unseen };
    }
    const { model, enabled } = input;
    if (enabled === !current.disabled.includes(model)) return null;
    if (enabled) {
      return {
        ...current,
        disabled: current.disabled.filter((id) => id !== model),
      };
    }
    if (!getAgentModelOptions(agentType).some(({ id }) => id === model))
      throw new ModelAvailabilityError(
        `Model "${model}" is not in the ${agentType} model list.`
      );
    if (selectableAgentModels(agentType).every(({ id }) => id === model))
      throw new ModelAvailabilityError("At least one model must stay on.");
    return { ...current, disabled: [...current.disabled, model] };
  });
}
