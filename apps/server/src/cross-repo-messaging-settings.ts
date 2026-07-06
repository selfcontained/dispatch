import type { Pool } from "pg";

import { getSetting, setSetting } from "./db/settings.js";

/**
 * Whether agent-to-agent messaging (dispatch_send_message / list_agents) may
 * address agents in *other* repositories. By default the addressable peer set
 * is scoped to the sender's git repo root; enabling this lifts that scoping for
 * local multi-repo workflows. This is a single server-wide setting — the gate
 * applies to every agent on this Dispatch server, not per device.
 *
 * The key and the "true"/"false" <-> boolean encoding live only here so the
 * route and the MCP handler share one definition (mirrors agent-type-settings).
 */
const CROSS_REPO_MESSAGING_KEY = "cross_repo_messaging_enabled";

export async function isCrossRepoMessagingEnabled(
  pool: Pool
): Promise<boolean> {
  return (await getSetting(pool, CROSS_REPO_MESSAGING_KEY)) === "true";
}

export async function setCrossRepoMessagingEnabled(
  pool: Pool,
  enabled: boolean
): Promise<void> {
  await setSetting(pool, CROSS_REPO_MESSAGING_KEY, enabled ? "true" : "false");
}
