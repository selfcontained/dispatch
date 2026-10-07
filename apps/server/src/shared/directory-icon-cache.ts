import type { Pool } from "pg";

import { detectRepoIcon } from "./repo-icon.js";

const ICON_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const pendingByPool = new WeakMap<Pool, Map<string, Promise<string | null>>>();

async function scanAndStore(pool: Pool, cwd: string): Promise<string | null> {
  const iconPath = await detectRepoIcon(cwd);
  await pool.query(
    `INSERT INTO directory_icons (cwd, icon_path, checked_at)
     VALUES ($1, $2, now())
     ON CONFLICT (cwd) DO UPDATE
     SET icon_path = EXCLUDED.icon_path, checked_at = EXCLUDED.checked_at`,
    [cwd, iconPath]
  );
  return iconPath;
}

export async function getDirectoryIconPath(
  pool: Pool,
  cwd: string
): Promise<string | null> {
  const cached = await pool.query<{
    icon_path: string | null;
    checked_at: Date;
  }>("SELECT icon_path, checked_at FROM directory_icons WHERE cwd = $1", [cwd]);
  const row = cached.rows[0];
  if (row && Date.now() - row.checked_at.getTime() < ICON_CACHE_MAX_AGE_MS) {
    return row.icon_path;
  }

  let pendingLookups = pendingByPool.get(pool);
  if (!pendingLookups) {
    pendingLookups = new Map();
    pendingByPool.set(pool, pendingLookups);
  }
  const pending = pendingLookups.get(cwd);
  if (pending) return pending;
  const lookup = scanAndStore(pool, cwd);
  pendingLookups.set(cwd, lookup);
  try {
    return await lookup;
  } finally {
    pendingLookups.delete(cwd);
  }
}
