import type { Pool } from "pg";

/** Read a single value from the settings table. Returns null if unset. */
export async function getSetting(pool: Pool, key: string): Promise<string | null> {
  const result = await pool.query<{ value: string }>(
    "SELECT value FROM settings WHERE key = $1",
    [key]
  );
  return result.rows[0]?.value ?? null;
}

/** Upsert a value in the settings table. */
export async function setSetting(pool: Pool, key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value]
  );
}

/** Remove a value from the settings table. */
export async function deleteSetting(pool: Pool, key: string): Promise<void> {
  await pool.query("DELETE FROM settings WHERE key = $1", [key]);
}
