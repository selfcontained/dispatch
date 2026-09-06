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

/** Keep known providers with a positive finite amount; drop the rest. */
export function sanitizeUsageBudgets(input: unknown): UsageBudgets {
  const out: UsageBudgets = {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return out;
  }
  for (const [id, value] of Object.entries(input as Record<string, unknown>)) {
    if (!isUsageProviderId(id)) continue;
    const amount = typeof value === "string" ? Number(value) : value;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
      continue;
    }
    out[id] = Math.round(amount * 100) / 100;
  }
  return out;
}

export async function getUsageBudgets(pool: Pool): Promise<UsageBudgets> {
  const raw = await getSetting(pool, USAGE_BUDGETS_KEY);
  if (!raw) return {};
  try {
    return sanitizeUsageBudgets(JSON.parse(raw));
  } catch {
    return {};
  }
}

export async function setUsageBudgets(
  pool: Pool,
  budgets: UsageBudgets
): Promise<UsageBudgets> {
  const sanitized = sanitizeUsageBudgets(budgets);
  await setSetting(pool, USAGE_BUDGETS_KEY, JSON.stringify(sanitized));
  return sanitized;
}
