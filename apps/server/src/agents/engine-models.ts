import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import { getSetting, setSetting } from "../db/settings.js";
import {
  getAgentModelOptions,
  setLearnedAgentModels,
  type AgentModelOption,
} from "../shared/agent-models.js";
import { AGENT_TYPES, type AgentType } from "../shared/agent-types.js";

/** The settings key an engine's learned list lives under. */
const settingKey = (agentType: AgentType) => `agent_models:${agentType}`;

type StoredEngineModels = { models: AgentModelOption[]; seenAt: string };

export type EngineModelReport = {
  /** The model the engine is running now. */
  current: string;
  /** Everything it offers, groups flattened, in the engine's order. */
  choices: AgentModelOption[];
};

/**
 * An engine's name for a model as a person would say it. codex-acp strips
 * the family off its GPT models ("gpt-5.6-sol" is published as "5.6 Sol")
 * because its own picker shows them under a "GPT" heading; the flat list
 * here has no heading, so the family goes back on.
 */
function modelLabel(value: string, name: string): string {
  // Only a bare version ("5.6 Sol") is a stripped name; anything else is
  // the engine's own wording and stays as it is.
  if (/^gpt-/i.test(value) && /^\d/.test(name)) return `GPT-${name}`;
  return name;
}

/**
 * The model option among an engine's session config options, or null when
 * it publishes none. Engines name it `model` or file it under the `model`
 * category; either counts, and the first match wins.
 */
export function modelOptionOf(
  options: readonly SessionConfigOption[]
): EngineModelReport | null {
  const option = options.find(
    (o) => o.type === "select" && (o.id === "model" || o.category === "model")
  );
  if (!option || option.type !== "select") return null;
  const choices: AgentModelOption[] = [];
  const add = (o: { value: string; name: string }, group?: string) => {
    // The picker has its own "Default" (no override); the engine's entry
    // for the same thing would be a second one.
    if (o.value === "default") return;
    // A grouped choice is named within its group ("GPT" › "6 Astra"); the
    // flat list needs the whole name.
    const name = modelLabel(o.value, o.name);
    const label =
      group && !name.toLowerCase().startsWith(group.toLowerCase())
        ? `${group} ${name}`
        : name;
    choices.push({ id: o.value, label });
  };
  for (const entry of option.options) {
    if ("group" in entry) entry.options.forEach((o) => add(o, entry.name));
    else add(entry);
  }
  const current = String(option.currentValue);
  return { current, choices };
}

/** At boot: what earlier sessions taught, so the pickers are right before any engine runs again. */
export async function loadLearnedAgentModels(pool: Pool): Promise<void> {
  for (const agentType of AGENT_TYPES) {
    const raw = await getSetting(pool, settingKey(agentType));
    if (!raw) continue;
    try {
      const stored = JSON.parse(raw) as StoredEngineModels;
      if (Array.isArray(stored.models)) {
        setLearnedAgentModels(agentType, stored.models);
      }
    } catch {
      // A corrupt entry is replaced the next time the engine reports.
    }
  }
}

/**
 * An engine reported its config options. The model it is running goes on
 * the agent, so the stream and the sidebar show the truth rather than the
 * request; the list it offers becomes the picker's catalog for that type.
 * Returns whether the agent's stored model changed, and whether the
 * catalog for its type did — the open pickers need to hear about that.
 */
export async function recordEngineModels(
  deps: { pool: Pool; logger: FastifyBaseLogger },
  agent: { id: string; type: AgentType; model: string | null },
  options: readonly SessionConfigOption[]
): Promise<{ modelChanged: boolean; modelsChanged: boolean }> {
  const report = modelOptionOf(options);
  if (!report) return { modelChanged: false, modelsChanged: false };
  const modelsChanged =
    report.choices.length > 0 &&
    !sameModels(getAgentModelOptions(agent.type), report.choices);
  if (report.choices.length > 0) {
    setLearnedAgentModels(agent.type, report.choices);
    const stored: StoredEngineModels = {
      models: report.choices,
      seenAt: new Date().toISOString(),
    };
    await setSetting(deps.pool, settingKey(agent.type), JSON.stringify(stored));
  }
  if (report.current === agent.model)
    return { modelChanged: false, modelsChanged };
  await deps.pool.query(
    "UPDATE agents SET model = $2, updated_at = NOW() WHERE id = $1",
    [agent.id, report.current]
  );
  deps.logger.info(
    { agentId: agent.id, model: report.current, requested: agent.model },
    "agent model as the engine reports it"
  );
  return { modelChanged: true, modelsChanged };
}

function sameModels(
  a: readonly AgentModelOption[],
  b: readonly AgentModelOption[]
): boolean {
  return (
    a.length === b.length &&
    a.every((o, i) => o.id === b[i]?.id && o.label === b[i]?.label)
  );
}
