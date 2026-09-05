import type { Pool } from "pg";

import { getSetting, setSetting } from "./db/settings.js";

/**
 * Whether the Chat tab (docs/chat-surface-plan.md) is offered in the web UI
 * and the chat launch-guidance rule is included at agent launch. Off by
 * default: with the flag off nothing in the app changes.
 *
 * The routes and the dispatch_chat_* MCP tools work regardless of the flag —
 * it is purely a UI switch, a launch-guidance switch, and the choice of which
 * description dispatch_chat_post announces itself with. Read per launch, per
 * settings request, and per agent MCP request; the last of those is not a
 * cold path, but the lookup is small beside the two git resolutions that
 * route already runs, so there is still no in-memory cache.
 */
const CHAT_SURFACE_KEY = "chat_surface_enabled";

export async function isChatSurfaceEnabled(pool: Pool): Promise<boolean> {
  return (await getSetting(pool, CHAT_SURFACE_KEY)) === "true";
}

export async function setChatSurfaceEnabled(
  pool: Pool,
  enabled: boolean
): Promise<void> {
  await setSetting(pool, CHAT_SURFACE_KEY, enabled ? "true" : "false");
}
