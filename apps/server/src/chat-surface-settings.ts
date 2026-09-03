import type { Pool } from "pg";

import { getSetting, setSetting } from "./db/settings.js";

/**
 * Whether the Chat tab (docs/chat-surface-plan.md) is offered in the web UI
 * and the chat launch-guidance rule is included at agent launch. Off by
 * default: with the flag off nothing in the app changes.
 *
 * The routes and the dispatch_chat_* MCP tools work regardless of the flag —
 * it is purely a UI switch plus a launch-guidance switch. Read per launch and
 * per settings request (both cold paths), so no in-memory cache.
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
