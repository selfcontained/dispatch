import type { Pool } from "pg";

import { getSetting, setSetting } from "./db/settings.js";

/**
 * Whether launch guidance is trimmed to the rules the Dispatch plugin's
 * skills do NOT cover. **On by default** since the token-economy work: around
 * 5,800 characters of guidance were being assembled into every session, and
 * the detail the trim drops is carried either by the MCP tool schema itself or
 * by a plugin skill. The one rule with a demonstrated failure history, the
 * `dispatch_share_file` nudge, survives the trim on purpose.
 *
 * The cost of that default is real and is not smoothed over here. This is a
 * user *assertion*, not detection: the CLIs own plugin install state
 * (`~/.claude/settings.json`, `~/.codex/config.toml`) and Dispatch never reads
 * it. On a server without the plugin installed, the trim now drops guidance
 * with only the tool schemas behind it. That is the trade the default makes,
 * and `false` is how it is taken back.
 *
 * Unset reads as on, so flipping the default needed no migration; an explicit
 * `"false"` is still honoured.
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
  return (await getSetting(pool, TRIMMED_LAUNCH_GUIDANCE_KEY)) !== "false";
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
