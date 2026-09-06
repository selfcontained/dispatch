import type { Pool } from "pg";
import {
  HARNESS_USAGE_PROVIDERS,
  type HarnessUsageProviderId,
  type UsageBudgets,
} from "@dispatch/shared";

import { getSetting, setSetting } from "./db/settings.js";

/**
 * Monthly spend budgets per provider key, set in Settings. Only the usage
 * dialog reads them, to draw a bar against the month's spend. Empty by
 * default: no row, no bar.
 */
const USAGE_BUDGETS_KEY = "usage_budgets";

const PROVIDER_IDS = new Set<string>(HARNESS_USAGE_PROVIDERS.map((p) => p.id));

export function isUsageProviderId(id: unknown): id is HarnessUsageProviderId {
  return typeof id === "string" && PROVIDER_IDS.has(id);
}

/**
 * The one definition of an acceptable budgets object: known providers only,
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
    if (!isUsageProviderId(id)) {
      return { ok: false, error: `Unknown provider: ${id}.` };
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
