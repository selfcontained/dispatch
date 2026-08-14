import type { Pool } from "pg";

import { getSetting, setSetting } from "./db/settings.js";

/**
 * Whether launch guidance is trimmed to the rules the Dispatch plugin's
 * skills do NOT cover. Off by default — every agent gets the full ruleset,
 * which is correct for anyone who hasn't installed the plugin.
 *
 * This is a user *assertion*, not detection: the CLIs own plugin install
 * state (`~/.claude/settings.json`, `~/.codex/config.toml`) and Dispatch
 * never reads it. Turning this on without the plugin installed silently
 * drops guidance with nothing replacing it, which is why the setting copy
 * says so and the default is off.
 *
 * Read once per agent launch (a cold path that already hits the DB), so
 * there's no cache here — unlike injection-hold, which is consulted on
 * every injection. Guidance is composed at launch, so a flip only affects
 * agents started afterwards.
 */
const TRIMMED_LAUNCH_GUIDANCE_KEY = "trimmed_launch_guidance_enabled";

export async function isTrimmedLaunchGuidanceEnabled(
  pool: Pool
): Promise<boolean> {
  return (await getSetting(pool, TRIMMED_LAUNCH_GUIDANCE_KEY)) === "true";
}

export async function setTrimmedLaunchGuidanceEnabled(
  pool: Pool,
  enabled: boolean
): Promise<void> {
  await setSetting(
    pool,
    TRIMMED_LAUNCH_GUIDANCE_KEY,
    enabled ? "true" : "false"
  );
}
