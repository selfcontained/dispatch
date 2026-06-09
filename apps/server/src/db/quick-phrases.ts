import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type QuickPhrase = {
  id: string;
  text: string;
  sortOrder: number;
  createdAt: string;
};

type QuickPhraseRow = {
  id: string;
  text: string;
  sort_order: number;
  created_at: Date;
};

function rowToQuickPhrase(row: QuickPhraseRow): QuickPhrase {
  return {
    id: row.id,
    text: row.text,
    sortOrder: row.sort_order,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listQuickPhrases(pool: Pool): Promise<QuickPhrase[]> {
  const result = await pool.query<QuickPhraseRow>(
    "SELECT id, text, sort_order, created_at FROM quick_phrases ORDER BY sort_order ASC, created_at ASC"
  );
  return result.rows.map(rowToQuickPhrase);
}

export async function createQuickPhrase(
  pool: Pool,
  input: { text: string }
): Promise<QuickPhrase> {
  const id = randomUUID();
  const result = await pool.query<QuickPhraseRow>(
    `INSERT INTO quick_phrases (id, text)
     VALUES ($1, $2)
     RETURNING id, text, sort_order, created_at`,
    [id, input.text]
  );
  return rowToQuickPhrase(result.rows[0]!);
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
