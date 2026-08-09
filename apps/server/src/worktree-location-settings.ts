import type { Pool } from "pg";

import { getSetting } from "./db/settings.js";

export const WORKTREE_LOCATION_KEY = "worktree_location";

export const VALID_WORKTREE_LOCATIONS = ["sibling", "nested"] as const;

export type WorktreeLocation = (typeof VALID_WORKTREE_LOCATIONS)[number];

export function isWorktreeLocation(value: unknown): value is WorktreeLocation {
  return (
    typeof value === "string" &&
    (VALID_WORKTREE_LOCATIONS as readonly string[]).includes(value)
  );
}

/**
 * The instance-wide worktree placement setting, falling back to "sibling" when
 * unset or invalid. Every path that creates an agent worktree must go through
 * here, or MCP-launched agents end up placed differently from UI-launched ones.
 */
export async function getWorktreeLocation(
  pool: Pool
): Promise<WorktreeLocation> {
  const raw = await getSetting(pool, WORKTREE_LOCATION_KEY);
  return isWorktreeLocation(raw) ? raw : "sibling";
}
