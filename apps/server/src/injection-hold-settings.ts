import type { Pool } from "pg";

import { getSetting, setSetting } from "./db/settings.js";

/**
 * Whether automated prompt injections wait for the user to pause typing in
 * the terminal before delivering (the InjectionCoordinator quiet gate).
 * Default off — injections deliver immediately, matching pre-gate behavior.
 * Per-agent write serialization is always on regardless of this setting.
 *
 * The coordinator consults this on every injection via the module-level
 * cache: the settings row is loaded once at boot and kept in sync by the
 * settings route, so the hot path never reads the DB. Single server-wide
 * setting (one server process owns the cache).
 */
const INJECTION_HOLD_KEY = "injection_hold_enabled";

let cachedEnabled = false;

export async function loadInjectionHoldEnabled(pool: Pool): Promise<boolean> {
  cachedEnabled = (await getSetting(pool, INJECTION_HOLD_KEY)) === "true";
  return cachedEnabled;
}

export function injectionHoldEnabled(): boolean {
  return cachedEnabled;
}

export async function setInjectionHoldEnabled(
  pool: Pool,
  enabled: boolean
): Promise<void> {
  await setSetting(pool, INJECTION_HOLD_KEY, enabled ? "true" : "false");
  cachedEnabled = enabled;
}
