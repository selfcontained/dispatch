import { randomUUID } from "node:crypto";
import path from "node:path";

import type { Pool } from "pg";

import type { JobAgentType } from "../jobs/store.js";

export type TemplateRecord = {
  id: string;
  directory: string;
  name: string;
  prompt: string | null;
  agentType: JobAgentType;
  useWorktree: boolean;
  baseBranch: string | null;
  branchName: string | null;
  fullAccess: boolean;
  callable: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TemplateConfigUpdate = {
  name?: string;
  prompt?: string | null;
  agentType?: JobAgentType;
  useWorktree?: boolean;
  baseBranch?: string | null;
  branchName?: string | null;
  fullAccess?: boolean;
  callable?: boolean;
};

export type ParsedArg = {
  name: string;
  key: string;
  placeholder: string;
};

const ARG_REGEX = /\{\{D:([^}]+)\}\}/g;

export function parseTemplateArgs(prompt: string): ParsedArg[] {
  const seen = new Set<string>();
  const args: ParsedArg[] = [];
  let match;
  while ((match = ARG_REGEX.exec(prompt)) !== null) {
    const name = match[1].trim();
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      args.push({ name, key, placeholder: match[0] });
    }
  }
  return args;
}

export function substituteArgs(
  prompt: string,
  args: Record<string, string>
): string {
  const parsed = parseTemplateArgs(prompt);
  const missing = parsed.filter((a) => !(a.key in args) && !(a.name in args));
  if (missing.length > 0) {
    throw new Error(
      `Missing required template arguments: ${missing.map((a) => a.name).join(", ")}`
    );
  }
  return prompt.replace(ARG_REGEX, (_match, rawName: string) => {
    const name = rawName.trim();
    const key = name.toLowerCase();
    return args[key] ?? args[name] ?? "";
  });
}

export class TemplateStore {
  constructor(private readonly pool: Pool) {}

  async createTemplate(input: {
    name: string;
    directory: string;
    prompt: string | null;
    agentType: JobAgentType;
    useWorktree: boolean;
    baseBranch: string | null;
    branchName: string | null;
    fullAccess: boolean;
    callable: boolean;
  }): Promise<TemplateRecord> {
    const id = randomUUID();
    try {
      const result = await this.pool.query(
        `
        INSERT INTO templates (id, directory, name, prompt, agent_type, use_worktree, base_branch, branch_name, full_access, callable)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING ${this.columns()}
        `,
        [
          id,
          path.resolve(input.directory),
          input.name,
          input.prompt,
          input.agentType,
          input.useWorktree,
          input.baseBranch,
          input.branchName,
          input.fullAccess,
          input.callable,
        ]
      );
      return mapTemplate(result.rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new Error(
          `A template named "${input.name}" already exists in directory "${input.directory}".`
        );
      }
      throw error;
    }
  }

  async getTemplate(id: string): Promise<TemplateRecord | null> {
    const result = await this.pool.query(
      `SELECT ${this.columns()} FROM templates WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? mapTemplate(result.rows[0]) : null;
  }

  async getTemplateByDirectoryAndName(
    directory: string,
    name: string
  ): Promise<TemplateRecord | null> {
    const result = await this.pool.query(
      `SELECT ${this.columns()} FROM templates WHERE directory = $1 AND name = $2`,
      [path.resolve(directory), name]
    );
    return result.rows[0] ? mapTemplate(result.rows[0]) : null;
  }

  async listTemplates(filter?: {
    callable?: boolean;
  }): Promise<TemplateRecord[]> {
    let query = `SELECT ${this.columns()} FROM templates`;
    const params: unknown[] = [];
    if (filter?.callable !== undefined) {
      query += ` WHERE callable = $1`;
      params.push(filter.callable);
    }
    query += ` ORDER BY name ASC, directory ASC`;
    const result = await this.pool.query(query, params);
    return result.rows.map((row) => mapTemplate(row));
  }

  async updateTemplate(
    id: string,
    input: TemplateConfigUpdate
  ): Promise<TemplateRecord> {
    try {
      const result = await this.pool.query(
        `
        UPDATE templates
        SET name = COALESCE($2, name),
            prompt = CASE WHEN $3 THEN $4 ELSE prompt END,
            agent_type = COALESCE($5, agent_type),
            use_worktree = COALESCE($6, use_worktree),
            base_branch = CASE WHEN $7 THEN $8 ELSE base_branch END,
            branch_name = CASE WHEN $9 THEN $10 ELSE branch_name END,
            full_access = COALESCE($11, full_access),
            callable = COALESCE($12, callable),
            updated_at = NOW()
        WHERE id = $1
        RETURNING ${this.columns()}
        `,
        [
          id,
          input.name,
          Object.prototype.hasOwnProperty.call(input, "prompt"),
          input.prompt ?? null,
          input.agentType,
          input.useWorktree,
          Object.prototype.hasOwnProperty.call(input, "baseBranch"),
          input.baseBranch ?? null,
          Object.prototype.hasOwnProperty.call(input, "branchName"),
          input.branchName ?? null,
          input.fullAccess,
          input.callable,
        ]
      );
      if (!result.rows[0]) throw new Error(`Template ${id} not found.`);
      return mapTemplate(result.rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new Error(
          `A template named "${input.name}" already exists in this directory.`
        );
      }
      throw error;
    }
  }

  async deleteTemplate(id: string): Promise<TemplateRecord> {
    const result = await this.pool.query(
      `
      DELETE FROM templates
      WHERE id = $1
      RETURNING ${this.columns()}
      `,
      [id]
    );
    if (!result.rows[0]) throw new Error(`Template ${id} not found.`);
    return mapTemplate(result.rows[0]);
  }

  async hasJobsReferencing(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM jobs WHERE template_id = $1 LIMIT 1`,
      [id]
    );
    return result.rows.length > 0;
  }

  private columns(): string {
    return `
      id,
      directory,
      name,
      prompt,
      agent_type AS "agentType",
      use_worktree AS "useWorktree",
      base_branch AS "baseBranch",
      branch_name AS "branchName",
      full_access AS "fullAccess",
      callable,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    `;
  }
}

function mapTemplate(row: Record<string, unknown>): TemplateRecord {
  return row as TemplateRecord;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}
