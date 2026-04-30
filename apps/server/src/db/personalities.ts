import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import { deleteSetting, getSetting, setSetting } from "./settings.js";

const ACTIVE_PERSONALITY_KEY = "active_personality_id";

export type Personality = {
  id: string;
  name: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
};

type PersonalityRow = {
  id: string;
  name: string;
  prompt: string;
  created_at: Date;
  updated_at: Date;
};

function rowToPersonality(row: PersonalityRow): Personality {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listPersonalities(pool: Pool): Promise<Personality[]> {
  const result = await pool.query<PersonalityRow>(
    "SELECT id, name, prompt, created_at, updated_at FROM personalities ORDER BY created_at ASC"
  );
  return result.rows.map(rowToPersonality);
}

export async function getPersonality(
  pool: Pool,
  id: string
): Promise<Personality | null> {
  const result = await pool.query<PersonalityRow>(
    "SELECT id, name, prompt, created_at, updated_at FROM personalities WHERE id = $1",
    [id]
  );
  const row = result.rows[0];
  return row ? rowToPersonality(row) : null;
}

export async function createPersonality(
  pool: Pool,
  input: { name: string; prompt: string }
): Promise<Personality> {
  const id = randomUUID();
  const result = await pool.query<PersonalityRow>(
    `INSERT INTO personalities (id, name, prompt)
     VALUES ($1, $2, $3)
     RETURNING id, name, prompt, created_at, updated_at`,
    [id, input.name, input.prompt]
  );
  return rowToPersonality(result.rows[0]!);
}

export async function updatePersonality(
  pool: Pool,
  id: string,
  input: { name?: string; prompt?: string }
): Promise<Personality | null> {
  const result = await pool.query<PersonalityRow>(
    `UPDATE personalities
     SET name = COALESCE($2, name),
         prompt = COALESCE($3, prompt),
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, name, prompt, created_at, updated_at`,
    [id, input.name ?? null, input.prompt ?? null]
  );
  const row = result.rows[0];
  return row ? rowToPersonality(row) : null;
}

export async function deletePersonality(
  pool: Pool,
  id: string
): Promise<boolean> {
  // Atomic delete + active-id clear in one round-trip. The first CTE deletes
  // the row; the second clears the active-id setting iff the row existed and
  // was the active one. The trailing SELECT always returns one row, so we
  // can read the deletion outcome without depending on either DELETE's
  // RETURNING set. Closes the read-then-delete-then-clear race that an
  // out-of-band activate would otherwise hit.
  const result = await pool.query<{ deleted_count: number }>(
    `WITH deleted AS (
       DELETE FROM personalities WHERE id = $1 RETURNING id
     ),
     cleared AS (
       DELETE FROM settings
       WHERE key = 'active_personality_id'
         AND value = $1
         AND EXISTS (SELECT 1 FROM deleted)
     )
     SELECT COUNT(*)::int AS deleted_count FROM deleted`,
    [id]
  );
  return (result.rows[0]?.deleted_count ?? 0) > 0;
}

export async function getActivePersonalityId(
  pool: Pool
): Promise<string | null> {
  const value = await getSetting(pool, ACTIVE_PERSONALITY_KEY);
  return value && value.length > 0 ? value : null;
}

export async function setActivePersonalityId(
  pool: Pool,
  id: string | null
): Promise<void> {
  if (id === null) {
    await deleteSetting(pool, ACTIVE_PERSONALITY_KEY);
    return;
  }
  await setSetting(pool, ACTIVE_PERSONALITY_KEY, id);
}

export async function getActivePersonality(
  pool: Pool
): Promise<Personality | null> {
  const id = await getActivePersonalityId(pool);
  if (!id) return null;
  return getPersonality(pool, id);
}
