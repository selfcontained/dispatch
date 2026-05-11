import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import type { AgentManager } from "../agents/manager.js";
import type { AgentRecord } from "../agents/types.js";
import type { JobAgentType } from "../jobs/store.js";
import { sanitizeAgentName } from "../shared/lib/agent-strings.js";
import {
  TemplateStore,
  parseTemplateArgs,
  substituteArgs,
  type TemplateRecord,
} from "./store.js";

export type AddTemplateInput = {
  name: string;
  directory: string;
  description?: string | null;
  prompt?: string | null;
  agentType?: JobAgentType;
  useWorktree?: boolean;
  baseBranch?: string | null;
  branchName?: string | null;
  fullAccess?: boolean;
  callable?: boolean;
};

export type LaunchTemplateInput = {
  templateId: string;
  args?: Record<string, string>;
  directory?: string;
  agentType?: JobAgentType;
};

export type LaunchResult = {
  agent: AgentRecord;
  templateId: string;
  templateName: string;
};

export class TemplateService {
  readonly store: TemplateStore;

  constructor(
    pool: Pool,
    private readonly agentManager: AgentManager,
    private readonly logger: FastifyBaseLogger
  ) {
    this.store = new TemplateStore(pool);
  }

  async addTemplate(input: AddTemplateInput): Promise<TemplateRecord> {
    const template = await this.store.createTemplate({
      name: input.name.trim(),
      directory: input.directory,
      description: input.description ?? null,
      prompt: input.prompt ?? null,
      agentType: input.agentType ?? "claude",
      useWorktree: input.useWorktree ?? false,
      baseBranch: input.baseBranch ?? null,
      branchName: input.branchName ?? null,
      fullAccess: input.fullAccess ?? false,
      callable: input.callable ?? true,
    });
    this.logger.info(
      { templateId: template.id, name: template.name },
      "Template added"
    );
    return template;
  }

  async updateTemplate(
    id: string,
    input: Partial<AddTemplateInput>
  ): Promise<TemplateRecord> {
    const updates: Parameters<TemplateStore["updateTemplate"]>[1] = {};
    if (input.name !== undefined) updates.name = input.name.trim();
    if (input.description !== undefined)
      updates.description = input.description;
    if (input.directory !== undefined) updates.directory = input.directory;
    if (input.prompt !== undefined) updates.prompt = input.prompt;
    if (input.agentType !== undefined) updates.agentType = input.agentType;
    if (input.useWorktree !== undefined)
      updates.useWorktree = input.useWorktree;
    if (input.baseBranch !== undefined) updates.baseBranch = input.baseBranch;
    if (input.branchName !== undefined) updates.branchName = input.branchName;
    if (input.fullAccess !== undefined) updates.fullAccess = input.fullAccess;
    if (input.callable !== undefined) updates.callable = input.callable;

    const updated = await this.store.updateTemplate(id, updates);
    this.logger.info(
      { templateId: updated.id, name: updated.name },
      "Template updated"
    );
    return updated;
  }

  async removeTemplate(id: string): Promise<TemplateRecord> {
    const hasJobs = await this.store.hasJobsReferencing(id);
    if (hasJobs) {
      throw new Error(
        `Cannot delete template — it is referenced by one or more jobs. Delete the jobs first.`
      );
    }
    const removed = await this.store.deleteTemplate(id);
    this.logger.info(
      { templateId: removed.id, name: removed.name },
      "Template removed"
    );
    return removed;
  }

  async listTemplates(filter?: {
    callable?: boolean;
    excludeJobBacked?: boolean;
  }): Promise<TemplateRecord[]> {
    return await this.store.listTemplates(filter);
  }

  async getTemplate(id: string): Promise<TemplateRecord | null> {
    return await this.store.getTemplate(id);
  }

  async launchTemplate(input: LaunchTemplateInput): Promise<LaunchResult> {
    const template = await this.store.getTemplate(input.templateId);
    if (!template) {
      throw new Error(`Template ${input.templateId} not found.`);
    }
    if (!template.prompt) {
      throw new Error(
        `Template "${template.name}" has no prompt configured. Add a prompt before launching.`
      );
    }

    const parsedArgs = parseTemplateArgs(template.prompt);
    const args = input.args ?? {};

    let finalPrompt: string;
    if (parsedArgs.length > 0) {
      finalPrompt = substituteArgs(template.prompt, args);
    } else {
      finalPrompt = template.prompt;
    }

    const initialPins = parsedArgs
      .filter((a) => args[a.key] != null || args[a.name] != null)
      .map((a) => ({
        label: a.name,
        value: args[a.key] ?? args[a.name],
        type: "string" as const,
      }));

    const cwd = input.directory ?? template.directory;
    const agent = await this.agentManager.createAgent({
      name: sanitizeAgentName(template.name),
      type: input.agentType ?? template.agentType,
      cwd,
      initialPrompt: finalPrompt,
      fullAccess: template.fullAccess,
      useWorktree: template.useWorktree,
      baseBranch: template.baseBranch ?? undefined,
      worktreeBranch: template.branchName ?? undefined,
      initialPins,
      templateId: template.id,
    });

    this.logger.info(
      {
        templateId: template.id,
        templateName: template.name,
        agentId: agent.id,
      },
      "Template launched"
    );

    return {
      agent,
      templateId: template.id,
      templateName: template.name,
    };
  }
}
