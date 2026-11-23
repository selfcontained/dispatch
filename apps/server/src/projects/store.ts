import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
export type ProjectRecord = {
  id: string;
  name: string;
  repoRoot: string | null;
  extraRoots: string[];
  color: string;
  iconOverride: string | null;
  createdAt: string;
  updatedAt: string;
};
const columns = `id, name, repo_root AS "repoRoot", extra_roots AS "extraRoots", color, icon_override AS "iconOverride", created_at AS "createdAt", updated_at AS "updatedAt"`;
export class ProjectStore {
  constructor(private readonly pool: Pool) {}
  async list(): Promise<ProjectRecord[]> {
    return (
      await this.pool.query(`SELECT ${columns} FROM projects ORDER BY name, id`)
    ).rows;
  }
  async listRoots() {
    const result = await this.pool.query<
      Pick<ProjectRecord, "id" | "name" | "repoRoot" | "extraRoots">
    >(
      'SELECT id, name, repo_root AS "repoRoot", extra_roots AS "extraRoots" FROM projects ORDER BY name, id'
    );
    return result.rows;
  }

  async get(id: string): Promise<ProjectRecord | null> {
    return (
      (
        await this.pool.query(`SELECT ${columns} FROM projects WHERE id=$1`, [
          id,
        ])
      ).rows[0] ?? null
    );
  }
  async getRepository(id: string): Promise<{ url: string | null } | null> {
    const result = await this.pool.query<{ url: string | null }>(
      "SELECT repository AS url FROM projects WHERE id=$1",
      [id]
    );
    return result.rows[0] ?? null;
  }

  async create(
    input: Pick<
      ProjectRecord,
      "name" | "repoRoot" | "color" | "iconOverride"
    > & { repository?: string | null }
  ): Promise<ProjectRecord> {
    return (
      await this.pool.query(
        `INSERT INTO projects(id,name,repo_root,color,icon_override,repository) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${columns}`,
        [
          randomUUID(),
          input.name,
          input.repoRoot,
          input.color,
          input.iconOverride,
          input.repository ?? null,
        ]
      )
    ).rows[0];
  }
  async update(
    id: string,
    input: Pick<ProjectRecord, "name" | "color" | "iconOverride">
  ): Promise<ProjectRecord | null> {
    return (
      (
        await this.pool.query(
          `UPDATE projects SET name=$2,color=$3,icon_override=$4,updated_at=now() WHERE id=$1 RETURNING ${columns}`,
          [id, input.name, input.color, input.iconOverride]
        )
      ).rows[0] ?? null
    );
  }
  async delete(id: string): Promise<boolean> {
    return (
      (await this.pool.query("DELETE FROM projects WHERE id=$1", [id]))
        .rowCount === 1
    );
  }
}
