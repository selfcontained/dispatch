import { randomUUID } from "node:crypto";
import path from "node:path";

import type { Pool } from "pg";

import type { AgentType } from "../agent-type-settings.js";
import { isUniqueViolation } from "../shared/lib/pg-errors.js";

export { parseTemplateArgs, substituteArgs } from "./arg-parser.js";

export type TemplateRecord = {
  id: string;
  directory: string;
  name: string;
  description: string | null;
  prompt: string | null;
  agentType: AgentType;
  model: string | null;
  useWorktree: boolean;
  baseBranch: string | null;
  branchName: string | null;
  fullAccess: boolean;
  callable: boolean;
  allowMedia: boolean;
  selfImprove: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TemplateConfigUpdate = {
  name?: string;
  description?: string | null;
  directory?: string;
  prompt?: string | null;
  agentType?: AgentType;
  model?: string | null;
  useWorktree?: boolean;
  baseBranch?: string | null;
  branchName?: string | null;
  fullAccess?: boolean;
  callable?: boolean;
  allowMedia?: boolean;
  selfImprove?: boolean;
};

export class TemplateStore {
  constructor(private readonly pool: Pool) {}

  async createTemplate(input: {
    name: string;
    directory: string;
    description: string | null;
    prompt: string | null;
    agentType: AgentType;
    model?: string | null;
    useWorktree: boolean;
    baseBranch: string | null;
    branchName: string | null;
    fullAccess: boolean;
    callable: boolean;
    allowMedia: boolean;
    selfImprove?: boolean;
  }): Promise<TemplateRecord> {
    const id = randomUUID();
    try {
      const result = await this.pool.query(
        `
        INSERT INTO templates (id, directory, name, description, prompt, agent_type, model, use_worktree, base_branch, branch_name, full_access, callable, allow_media, self_improve)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING ${this.columns()}
        `,
        [
          id,
          path.resolve(input.directory),
          input.name,
          input.description,
          input.prompt,
          input.agentType,
          input.model ?? null,
          input.useWorktree,
          input.baseBranch,
          input.branchName,
          input.fullAccess,
          input.callable,
          input.allowMedia,
          input.selfImprove ?? false,
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
    excludeJobBacked?: boolean;
  }): Promise<TemplateRecord[]> {
    let query = `SELECT ${this.columns()} FROM templates`;
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter?.callable !== undefined) {
      params.push(filter.callable);
      conditions.push(`callable = $${params.length}`);
    }
    if (filter?.excludeJobBacked) {
      conditions.push(
        `NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.template_id = templates.id)`
      );
    }
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(" AND ")}`;
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
      const hasDescription = Object.prototype.hasOwnProperty.call(
        input,
        "description"
      );
      const hasPrompt = Object.prototype.hasOwnProperty.call(input, "prompt");
      const hasBaseBranch = Object.prototype.hasOwnProperty.call(
        input,
        "baseBranch"
      );
      const hasBranchName = Object.prototype.hasOwnProperty.call(
        input,
        "branchName"
      );
      const resolvedDir = input.directory
        ? path.resolve(input.directory)
        : undefined;
      const result = await this.pool.query(
        `
        UPDATE templates
        SET name = COALESCE($2, name),
            description = CASE WHEN $3 THEN $4 ELSE description END,
            directory = COALESCE($5, directory),
            prompt = CASE WHEN $6 THEN $7 ELSE prompt END,
            agent_type = COALESCE($8, agent_type),
            model = CASE WHEN $9 THEN $10 ELSE model END,
            use_worktree = COALESCE($11, use_worktree),
            base_branch = CASE WHEN $12 THEN $13 ELSE base_branch END,
            branch_name = CASE WHEN $14 THEN $15 ELSE branch_name END,
            full_access = COALESCE($16, full_access),
            callable = COALESCE($17, callable),
            allow_media = COALESCE($18, allow_media),
            self_improve = COALESCE($19, self_improve),
            updated_at = NOW()
        WHERE id = $1
        RETURNING ${this.columns()}
        `,
        [
          id,
          input.name,
          hasDescription,
          input.description ?? null,
          resolvedDir,
          hasPrompt,
          input.prompt ?? null,
          input.agentType,
          Object.prototype.hasOwnProperty.call(input, "model"),
          input.model ?? null,
          input.useWorktree,
          hasBaseBranch,
          input.baseBranch ?? null,
          hasBranchName,
          input.branchName ?? null,
          input.fullAccess,
          input.callable,
          input.allowMedia,
          input.selfImprove,
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
      description,
      prompt,
      agent_type AS "agentType",
      model,
      use_worktree AS "useWorktree",
      base_branch AS "baseBranch",
      branch_name AS "branchName",
      full_access AS "fullAccess",
      callable,
      allow_media AS "allowMedia",
      self_improve AS "selfImprove",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    `;
  }
}

function mapTemplate(row: Record<string, unknown>): TemplateRecord {
  return row as TemplateRecord;
}
