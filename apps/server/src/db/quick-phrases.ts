import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type QuickPhrase = {
  id: string;
  label: string | null;
  text: string;
  sortOrder: number;
  createdAt: string;
};

type QuickPhraseRow = {
  id: string;
  label: string | null;
  text: string;
  sort_order: number;
  created_at: Date;
};

function rowToQuickPhrase(row: QuickPhraseRow): QuickPhrase {
  return {
    id: row.id,
    label: row.label,
    text: row.text,
    sortOrder: row.sort_order,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listQuickPhrases(pool: Pool): Promise<QuickPhrase[]> {
  const result = await pool.query<QuickPhraseRow>(
    "SELECT id, label, text, sort_order, created_at FROM quick_phrases ORDER BY sort_order ASC, created_at ASC"
  );
  return result.rows.map(rowToQuickPhrase);
}

export async function createQuickPhrase(
  pool: Pool,
  input: { label?: string | null; text: string }
): Promise<QuickPhrase> {
  const id = randomUUID();
  const label = input.label?.trim() || null;
  const result = await pool.query<QuickPhraseRow>(
    `INSERT INTO quick_phrases (id, label, text)
     VALUES ($1, $2, $3)
     RETURNING id, label, text, sort_order, created_at`,
    [id, label, input.text]
  );
  return rowToQuickPhrase(result.rows[0]!);
}

export async function updateQuickPhrase(
  pool: Pool,
  id: string,
  input: { label?: string | null; text?: string }
): Promise<QuickPhrase | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (input.label !== undefined) {
    fields.push(`label = $${idx++}`);
    values.push(input.label?.trim() || null);
  }
  if (input.text !== undefined) {
    fields.push(`text = $${idx++}`);
    values.push(input.text);
  }

  if (fields.length === 0) return null;

  values.push(id);
  const result = await pool.query<QuickPhraseRow>(
    `UPDATE quick_phrases SET ${fields.join(", ")} WHERE id = $${idx}
     RETURNING id, label, text, sort_order, created_at`,
    values
  );
  return result.rows[0] ? rowToQuickPhrase(result.rows[0]) : null;
}

export async function deleteQuickPhrase(
  pool: Pool,
  id: string
): Promise<boolean> {
  const result = await pool.query("DELETE FROM quick_phrases WHERE id = $1", [
    id,
  ]);
  return (result.rowCount ?? 0) > 0;
}
