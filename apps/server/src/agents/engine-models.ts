import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import {
  localRunnerSettings,
  namespaced,
  type RunnerSettings,
} from "../runners/settings-namespace.js";
import { getSetting, setSetting } from "../db/settings.js";
import {
  getAgentModelOptions,
  agentModelDefaults,
  setLearnedAgentModels,
  type AgentModelOption,
} from "../shared/agent-models.js";
import { AGENT_TYPES, type AgentType } from "../shared/agent-types.js";
import {
  prepareListedModels,
  commitModelChanges,
} from "./model-availability.js";
import type { Res } from "@dispatch/runner-protocol/contract";

/** The settings key an engine's learned list lives under. */
const settingKey = (agentType: AgentType, settings = localRunnerSettings) =>
  namespaced(settings, `agent_models:${agentType}`);

/** Durable ordering and ages, separate from main's catalog bytes. */
export type ModelObservation = {
  revision: number;
  observedAt?: string;
  effort: Record<string, string>;
};
export class SupersededModelObservation extends Error {}
export async function readModelObservation(
  pool: Pool,
  settings: RunnerSettings,
  type: AgentType
): Promise<ModelObservation> {
  const raw = await getSetting(
    pool,
    namespaced(settings, `agent_models_observation:${type}`)
  );
  try {
    const value = raw ? JSON.parse(raw) : {};
    return {
      revision:
        Number.isSafeInteger(value.revision) && value.revision >= 0
          ? value.revision
          : 0,
      observedAt:
        typeof value.observedAt === "string" ? value.observedAt : undefined,
      effort: Object.fromEntries(
        Object.entries(value.effort ?? {}).filter(
          (entry) => typeof entry[1] === "string"
        )
      ) as Record<string, string>,
    };
  } catch {
    return { revision: 0, effort: {} };
  }
}

type StoredEngineModels = {
  models: AgentModelOption[];
  defaultModel?: string;
  seenAt: string;
};

import {
  modelOptionOf,
  engineEffortOption,
  type EngineModelReport,
} from "@dispatch/runner-protocol/engine-options";
export {
  modelOptionOf,
  engineEffortOption,
  type EngineModelReport,
} from "@dispatch/runner-protocol/engine-options";

/** At boot: what earlier sessions taught, so the pickers are right before any engine runs again. */
export async function loadLearnedAgentModels(
  pool: Pool,
  runnerId = "local",
  settings: RunnerSettings = localRunnerSettings
): Promise<void> {
  for (const agentType of AGENT_TYPES) {
    const raw = await getSetting(pool, settingKey(agentType, settings));
    if (!raw) continue;
    try {
      // Ignore the old E2E fixture catalog until a real engine reports.
      const stored = JSON.parse(raw) as StoredEngineModels;
      if (
        Array.isArray(stored.models) &&
        !(
          stored.models.length === 2 &&
          stored.models.some((model) => model?.id === "default-model") &&
          stored.models.some((model) => model?.id === "other-model")
        )
      ) {
        setLearnedAgentModels(
          agentType,
          stored.models,
          stored.defaultModel,
          runnerId
        );
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
  options: readonly SessionConfigOption[],
  learnCatalog = true,
  catalog: { runnerId: string; settings: RunnerSettings } = {
    runnerId: "local",
    settings: localRunnerSettings,
  }
): Promise<{ modelChanged: boolean; modelsChanged: boolean }> {
  const report = modelOptionOf(options);
  if (!report) return { modelChanged: false, modelsChanged: false };
  const modelsChanged =
    learnCatalog &&
    (await learnEngineCatalog(deps.pool, agent, options, report, catalog));
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

async function learnEngineCatalog(
  pool: Pool,
  agent: { type: AgentType; model: string | null },
  options: readonly SessionConfigOption[],
  report: EngineModelReport,
  catalog: { runnerId: string; settings: RunnerSettings },
  refresh?: {
    refreshedAt: string;
    expectedRevision?: number;
  }
): Promise<boolean> {
  if (report.choices.length === 0 && !refresh) return false;
  return commitModelChanges(pool, async (client) => {
    const observation = await readModelObservation(
      client,
      catalog.settings,
      agent.type
    );
    if (
      refresh?.expectedRevision !== undefined &&
      observation.revision !== refresh.expectedRevision
    )
      throw new SupersededModelObservation(
        "A newer model observation committed during discovery."
      );
    const observedAt = refresh?.refreshedAt ?? new Date().toISOString();
    const effortTimes = new Map(Object.entries(observation.effort));
    // Retained effort is not a new observation of that model.
    for (const choice of report.choices)
      if (choice.id === report.current || choice.effort !== undefined)
        effortTimes.set(choice.id, observedAt);
    await setSetting(
      client,
      namespaced(catalog.settings, `agent_models_observation:${agent.type}`),
      JSON.stringify({
        revision: observation.revision + 1,
        observedAt,
        effort: Object.fromEntries(effortTimes),
      })
    );
    await setSetting(
      client,
      namespaced(catalog.settings, `agent_models_refresh:${agent.type}`),
      JSON.stringify({ refreshedAt: observedAt })
    );
    if (report.choices.length === 0) {
      return { result: false, publish() {} };
    }
    // Before the list is published, so a model that starts off is never offered.
    const availability = await prepareListedModels(
      client,
      agent.type,
      report.choices.map(({ id }) => id),
      catalog
    );
    const previous = getAgentModelOptions(agent.type, catalog.runnerId);
    const effort = engineEffortOption(options);
    report.choices = report.choices.map((choice) => {
      const known =
        choice.id === report.current
          ? effort
          : (choice.effort ??
            previous.find((old) => old.id === choice.id)?.effort);
      return known === undefined ? choice : { ...choice, effort: known };
    });
    const defaultModel =
      agent.model === null
        ? report.current
        : agentModelDefaults(catalog.runnerId)[agent.type];
    const modelsChanged =
      availability.changed ||
      !sameModels(previous, report.choices) ||
      defaultModel !== agentModelDefaults(catalog.runnerId)[agent.type];
    const stored: StoredEngineModels = {
      models: report.choices,
      defaultModel,
      seenAt: new Date().toISOString(),
    };
    for (const write of availability.writes)
      await setSetting(client, write.key, write.value);
    await setSetting(
      client,
      settingKey(agent.type, catalog.settings),
      JSON.stringify(stored)
    );
    return {
      result: modelsChanged,
      publish() {
        availability.publish();
        setLearnedAgentModels(
          agent.type,
          report.choices,
          defaultModel,
          catalog.runnerId
        );
      },
    };
  });
}

/** Live listing and agent observations share the same durable learning path. */
export function recordDiscoveredModels(
  pool: Pool,
  type: AgentType,
  result: Res<"engine.models">,
  catalog: { runnerId: string; settings: RunnerSettings },
  refreshedAt: string,
  selectedModel?: string,
  expectedRevision?: number
): Promise<boolean> {
  const current = result.current ?? result.defaultModel ?? "default";
  const effort =
    result.models.find((model) => model.id === current)?.effort ?? [];
  const options: SessionConfigOption[] = [
    {
      id: "effort",
      name: "Effort",
      type: "select",
      category: "thought_level",
      currentValue: effort[0]?.value ?? "default",
      options: effort,
    },
  ];
  return learnEngineCatalog(
    pool,
    { type, model: selectedModel ?? null },
    options,
    { current, choices: result.models },
    catalog,
    {
      refreshedAt,
      expectedRevision,
    }
  );
}

function sameModels(
  a: readonly AgentModelOption[],
  b: readonly AgentModelOption[]
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (o, i) =>
        o.id === b[i]?.id &&
        o.label === b[i]?.label &&
        JSON.stringify(o.effort) === JSON.stringify(b[i]?.effort)
    )
  );
}

/** Persist the live session's effort, including removal when a model has no option. */
export async function recordEngineEffort(
  pool: Pool,
  agent: { id: string; effort?: string | null },
  options: readonly SessionConfigOption[]
): Promise<boolean> {
  const option = options.find(
    (o) =>
      o.type === "select" &&
      (o.category === "thought_level" ||
        /effort|reasoning|thinking/i.test(o.id))
  );
  const value = option?.type === "select" ? String(option.currentValue) : null;
  const effort = value === "default" ? null : value;
  if (effort === (agent.effort ?? null)) return false;
  await pool.query(
    "UPDATE agents SET effort = $2, updated_at = NOW() WHERE id = $1",
    [agent.id, effort]
  );
  return true;
}

// An SDK upgrade must keep every field read by the neutral parsers assignable.
type AssertOptionCompatibility<T extends true> = T;
export type EngineOptionCompatibility = AssertOptionCompatibility<
  SessionConfigOption extends import("@dispatch/runner-protocol/engine-options").EngineConfigOption
    ? true
    : false
>;
