import type { Pool } from "pg";

import { getSetting, setSetting } from "./db/settings.js";

/**
 * Whether the Dispatch Harness agent type (`dispatch`) is offered anywhere:
 * the create dialog, the sidebar picker, jobs, templates, reviewer pickers,
 * `dispatch_launch_agent` and persona launches. Off by default, because the
 * harness needs an engine's CLI installed and logged in on the server, and a
 * curious click without either should not be the first thing a new install
 * sees.
 *
 * This is the one switch. `dispatch` is deliberately not a member of
 * `enabled_agent_types` (see `sanitizeEnabledAgentTypes`), so there is no
 * second place to turn the harness on and no way for the two to disagree.
 *
 * The flag gates creation and discovery only. Turning it off leaves running
 * dispatch agents running, and `/api/v1/agents/:id/harness/*` keeps serving
 * them.
 *
 * `settings` is a key/value table read through `getSetting`/`setSetting`, so
 * an install with no row reads false and no migration is needed. Read per
 * settings request and per creation attempt; the lookup is one small indexed
 * query beside work that already costs more.
 */
const DISPATCH_HARNESS_KEY = "dispatch_harness_enabled";

export async function isDispatchHarnessEnabled(pool: Pool): Promise<boolean> {
  return (await getSetting(pool, DISPATCH_HARNESS_KEY)) === "true";
}

export async function setDispatchHarnessEnabled(
  pool: Pool,
  enabled: boolean
): Promise<void> {
  await setSetting(pool, DISPATCH_HARNESS_KEY, enabled ? "true" : "false");
}
