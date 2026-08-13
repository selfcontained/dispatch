import type { Pool } from "pg";

import { getSetting, setSetting } from "../db/settings.js";

/**
 * Whether this instance exposes its API on the tailnet interface so linked
 * peers can reach it. Off by default; enabling requires a configured password
 * and a running tailscale — enforced in the route and again at bind time.
 */
const TAILNET_BIND_KEY = "peer_tailnet_bind_enabled";

export async function isTailnetBindEnabled(pool: Pool): Promise<boolean> {
  return (await getSetting(pool, TAILNET_BIND_KEY)) === "true";
}

export async function setTailnetBindEnabled(
  pool: Pool,
  enabled: boolean
): Promise<void> {
  await setSetting(pool, TAILNET_BIND_KEY, enabled ? "true" : "false");
}
