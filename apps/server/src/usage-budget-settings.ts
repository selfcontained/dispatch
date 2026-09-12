import type { Pool } from "pg";
import {
  HARNESS_BUDGET_ENGINE_IDS,
  type HarnessEngineId,
  type UsageBudgets,
} from "@dispatch/shared";

import { getSetting, setSetting } from "./db/settings.js";

/**
 * Monthly spend budgets per engine, set in Settings. Only the usage
 * dialog reads them, to draw a bar against the month's spend. Empty by
 * default: no row, no bar.
 */
const USAGE_BUDGETS_KEY = "usage_budgets";

const ENGINE_IDS = new Set<string>(HARNESS_BUDGET_ENGINE_IDS);

/** A cost-reporting engine id: the only kind a dollar budget can name. */
function isUsageEngineId(id: unknown): id is HarnessEngineId {
  return typeof id === "string" && ENGINE_IDS.has(id);
}

/**
 * The one definition of an acceptable budgets object: known engines only,
 * each a positive finite number of USD (numeric strings are not numbers).
 * Amounts keep two decimals. The route turns `ok: false` into a 400; the
 * store reads back through the same rule so a bad row on disk is dropped.
 */
export function parseUsageBudgets(
  input: unknown
): { ok: true; budgets: UsageBudgets } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "budgets must be an object." };
  }
  const budgets: UsageBudgets = {};
  for (const [id, value] of Object.entries(input as Record<string, unknown>)) {
    if (!isUsageEngineId(id)) {
      return { ok: false, error: `Unknown engine: ${id}.` };
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return {
        ok: false,
        error: `Budget for ${id} must be a positive number of USD.`,
      };
    }
    budgets[id] = Math.round(value * 100) / 100;
  }
  return { ok: true, budgets };
}

export async function getUsageBudgets(pool: Pool): Promise<UsageBudgets> {
  const raw = await getSetting(pool, USAGE_BUDGETS_KEY);
  if (!raw) return {};
  try {
    const parsed = parseUsageBudgets(JSON.parse(raw));
    return parsed.ok ? parsed.budgets : {};
  } catch {
    return {};
  }
}

/** Store budgets that already passed {@link parseUsageBudgets}. */
export async function setUsageBudgets(
  pool: Pool,
  budgets: UsageBudgets
): Promise<UsageBudgets> {
  await setSetting(pool, USAGE_BUDGETS_KEY, JSON.stringify(budgets));
  return budgets;
}
