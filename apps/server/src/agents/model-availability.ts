import {
  localRunnerSettings,
  namespaced,
  type RunnerSettings,
} from "../runners/settings-namespace.js";
import type { Pool } from "pg";

import { getSetting, setSetting } from "../db/settings.js";
import {
  getAgentModelAvailability,
  rememberCatalogRunner,
  catalogRunnerSettings,
  catalogUnion,
  agentModelCatalog,
  agentModelDefaults,
  agentModelAvailability,
  modelChoicesForRunner,
  getReportedModelHistory,
  setReportedModelHistory,
  getAgentModelOptions,
  getLearnedAgentModels,
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

function enqueue(work: () => Promise<boolean>): Promise<boolean> {
  const result = queue.then(work);
  queue = result.catch(() => {});
  return result;
}
async function saveShared(
  pool: Pool,
  agentType: AgentType,
  value: AgentModelAvailability
) {
  await setSetting(pool, settingKey(agentType), JSON.stringify(value));
  setAgentModelAvailability(agentType, value);
}
async function registeredRunners(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM runner_registrations WHERE revoked_at IS NULL AND cleared_at IS NULL ORDER BY created_at, id",
    []
  );
  return rows.map((row) => row.id);
}
/** Settings alone reads the union; local launch catalogs keep their existing endpoint. */
export async function settingsModelCatalog(pool: Pool) {
  const runnerIds = await registeredRunners(pool);
  const availability = agentModelAvailability();
  if (runnerIds.length === 0)
    return {
      models: agentModelCatalog(),
      defaults: agentModelDefaults(),
      availability,
    };
  for (const agentType of AGENT_TYPES) {
    const current = availability[agentType];
    if (!current) continue;
    const unseen = new Set(current.unseen);
    for (const id of runnerIds)
      for (const model of getReportedModelHistory(id, agentType).unseen)
        unseen.add(model);
    availability[agentType] = { ...current, unseen: [...unseen] };
  }
  return {
    models: runnerIds.length ? catalogUnion(runnerIds) : agentModelCatalog(),
    defaults: agentModelDefaults(),
    availability,
  };
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
export async function loadModelAvailability(
  pool: Pool,
  catalog: { runnerId: string; settings: RunnerSettings } = {
    runnerId: "local",
    settings: localRunnerSettings,
  }
): Promise<void> {
  rememberCatalogRunner(catalog.runnerId, catalog.settings);
  if (catalog.settings.modelReports === "history") {
    for (const agentType of AGENT_TYPES) {
      let stored: { known?: unknown; unseen?: unknown } | null = null;
      try {
        const raw = await getSetting(
          pool,
          namespaced(catalog.settings, settingKey(agentType))
        );
        if (raw) stored = JSON.parse(raw);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      setReportedModelHistory(catalog.runnerId, agentType, {
        known: Array.isArray(stored?.known)
          ? strings(stored.known)
          : (getLearnedAgentModels(agentType, catalog.runnerId)?.map(
              ({ id }) => id
            ) ?? null),
        unseen: strings(stored?.unseen),
      });
    }
    return;
  }
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
  ids: readonly string[],
  catalog: { runnerId: string; settings: RunnerSettings } = {
    runnerId: "local",
    settings: localRunnerSettings,
  }
): Promise<boolean> {
  rememberCatalogRunner(catalog.runnerId, catalog.settings);
  return enqueue(async () => {
    const shared = getAgentModelAvailability(agentType);
    const registered = await registeredRunners(pool);
    const idsOfRunners = new Set([...registered, catalog.runnerId]);
    const histories = [
      shared,
      ...[...idsOfRunners].map((id) => getReportedModelHistory(id, agentType)),
    ];
    const hasBaseline =
      registered.length > 0 ||
      histories.some((history) => history.known !== null);
    const knownAnywhere = new Set(
      histories.flatMap((history) => history.known ?? [])
    );
    const globallyNew = hasBaseline
      ? ids.filter((id) => !knownAnywhere.has(id))
      : [];
    const choices = modelChoicesForRunner(catalog.runnerId, agentType);
    const disabled =
      choices.autoEnable || globallyNew.length === 0
        ? shared.disabled
        : [...new Set([...shared.disabled, ...globallyNew])];
    const historyOnly = catalog.settings.modelReports === "history";
    const current = historyOnly
      ? getReportedModelHistory(catalog.runnerId, agentType)
      : shared;
    const found = ids.filter((id) => !current.known?.includes(id));
    const historyChanged = current.known === null || found.length > 0;
    const disabledChanged = disabled.length !== shared.disabled.length;
    if (!historyChanged && !disabledChanged) return false;
    const history = {
      known: current.known ? [...current.known, ...found] : [...ids],
      unseen: [...current.unseen, ...(current.known ? found : globallyNew)],
    };
    if (historyOnly) {
      // Persist the shared off-list first: a failed history write can then be
      // retried without ever publishing a new model as enabled by accident.
      if (disabledChanged)
        await saveShared(pool, agentType, { ...shared, disabled });
      if (historyChanged) {
        await setSetting(
          pool,
          namespaced(catalog.settings, settingKey(agentType)),
          JSON.stringify(history)
        );
        setReportedModelHistory(catalog.runnerId, agentType, history);
      }
    } else {
      await saveShared(pool, agentType, {
        ...shared,
        known: history.known,
        unseen: history.unseen,
        disabled,
      });
    }
    return true;
  });
}

export function updateModelAvailability(
  pool: Pool,
  agentType: AgentType,
  input: ModelAvailabilityChange
): Promise<boolean> {
  return enqueue(async () => {
    const current = getAgentModelAvailability(agentType);
    if ("seen" in input) {
      let changed = false;
      const unseen = current.unseen.filter((id) => !input.seen.includes(id));
      if (unseen.length !== current.unseen.length) {
        await saveShared(pool, agentType, { ...current, unseen });
        changed = true;
      }
      for (const runnerId of await registeredRunners(pool)) {
        const history = getReportedModelHistory(runnerId, agentType);
        const remaining = history.unseen.filter(
          (id) => !input.seen.includes(id)
        );
        const settings = catalogRunnerSettings(runnerId);
        if (!settings || remaining.length === history.unseen.length) continue;
        const next = { ...history, unseen: remaining };
        await setSetting(
          pool,
          namespaced(settings, settingKey(agentType)),
          JSON.stringify(next)
        );
        setReportedModelHistory(runnerId, agentType, next);
        changed = true;
      }
      return changed;
    }
    if ("autoEnable" in input) {
      if (input.autoEnable === current.autoEnable) return false;
      await saveShared(pool, agentType, {
        ...current,
        autoEnable: input.autoEnable,
      });
      return true;
    }
    const { model, enabled } = input;
    if (enabled === !current.disabled.includes(model)) return false;
    if (enabled) {
      await saveShared(pool, agentType, {
        ...current,
        disabled: current.disabled.filter((id) => id !== model),
      });
      return true;
    }
    const catalog = (await settingsModelCatalog(pool)).models[agentType] ?? [];
    if (!catalog.some((option) => option.id === model))
      throw new ModelAvailabilityError(
        `Model "${model}" is not in the ${agentType} model list.`
      );
    if (
      catalog
        .filter((option) => !current.disabled.includes(option.id))
        .every((option) => option.id === model)
    )
      throw new ModelAvailabilityError("At least one model must stay on.");
    await saveShared(pool, agentType, {
      ...current,
      disabled: [...current.disabled, model],
    });
    return true;
  });
}
