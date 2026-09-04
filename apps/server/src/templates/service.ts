import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import type { AgentManager } from "../agents/manager.js";
import type { AgentPin, AgentRecord } from "../agents/types.js";
import type { AgentType } from "../agent-type-settings.js";
import { sanitizeAgentName } from "../shared/lib/agent-strings.js";
import { renderTemplatePrompt } from "./launch-prompt.js";
import {
  applyAgentConfigDefaults,
  resolveAgentModelForUpdate,
  validateAgentModel,
} from "../shared/agent-models.js";
import {
  TemplateStore,
  parseTemplateArgs,
  type TemplateRecord,
} from "./store.js";
import { templateWorktreeConfig } from "./worktree-config.js";

export type AddTemplateInput = {
  name: string;
  directory: string;
  description?: string | null;
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

export type LaunchTemplateInput = {
  templateId: string;
  args?: Record<string, string>;
  directory?: string;
  agentType?: AgentType;
  /** Per-launch override. Undefined keeps the template's saved model; null
   * forces the CLI default. */
  model?: string | null;
  startupFiles?: Array<{
    fileName: string;
    originalName?: string;
    buffer: Buffer;
    source: "text" | "user";
    description?: string | null;
  }>;
  startupPins?: AgentPin[];
  /** Raw startup links, recorded as link attachments on the launch post
   * (the url pins the route made from them are `startupPins`). */
  startupLinks?: string[];
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
      ...applyAgentConfigDefaults(input),
      callable: input.callable ?? true,
      allowMedia: input.allowMedia ?? true,
      selfImprove: input.selfImprove ?? false,
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
    const existing = await this.store.getTemplate(id);
    if (!existing) throw new Error(`Template "${id}" not found.`);
    const updates: Parameters<TemplateStore["updateTemplate"]>[1] = {};
    if (input.name !== undefined) updates.name = input.name.trim();
    if (input.description !== undefined)
      updates.description = input.description;
    if (input.directory !== undefined) updates.directory = input.directory;
    if (input.prompt !== undefined) updates.prompt = input.prompt;
    const nextModel = resolveAgentModelForUpdate({
      inputAgentType: input.agentType,
      inputModel: input.model,
      existingAgentType: existing.agentType,
      existingModel: existing.model,
    });
    if (input.agentType !== undefined) updates.agentType = input.agentType;
    if (nextModel !== existing.model || input.model !== undefined)
      updates.model = nextModel;
    if (input.useWorktree !== undefined)
      updates.useWorktree = input.useWorktree;
    if (input.baseBranch !== undefined) updates.baseBranch = input.baseBranch;
    if (input.branchName !== undefined) updates.branchName = input.branchName;
    if (input.fullAccess !== undefined) updates.fullAccess = input.fullAccess;
    if (input.callable !== undefined) updates.callable = input.callable;
    if (input.allowMedia !== undefined) updates.allowMedia = input.allowMedia;
    if (input.selfImprove !== undefined)
      updates.selfImprove = input.selfImprove;

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

  async getTemplateByName(
    directory: string,
    name: string
  ): Promise<TemplateRecord | null> {
    return await this.store.getTemplateByDirectoryAndName(directory, name);
  }

  async launchTemplate(input: LaunchTemplateInput): Promise<LaunchResult> {
    const template = await this.store.getTemplate(input.templateId);
    if (!template) {
      throw new Error(`Template ${input.templateId} not found.`);
    }

    const resolvedType = input.agentType ?? template.agentType;
    const isTerminal = resolvedType === "terminal";
    const resolvedModel =
      input.model !== undefined
        ? validateAgentModel(resolvedType, input.model ?? undefined)
        : resolvedType === template.agentType
          ? (template.model ?? undefined)
          : undefined;

    if (!isTerminal && !template.prompt) {
      throw new Error(
        `Template "${template.name}" has no prompt configured. Add a prompt before launching.`
      );
    }
    if (
      !template.allowMedia &&
      ((input.startupFiles && input.startupFiles.length > 0) ||
        (input.startupPins && input.startupPins.length > 0))
    ) {
      throw new Error(
        `Template "${template.name}" does not allow media attachments.`
      );
    }

    let finalPrompt: string | undefined;
    let initialPins: AgentPin[] = [];

    if (!isTerminal && template.prompt) {
      const parsedArgs = parseTemplateArgs(template.prompt);
      const args = input.args ?? {};

      finalPrompt = renderTemplatePrompt(
        { ...template, prompt: template.prompt },
        args
      );

      const argPins = parsedArgs
        .filter((a) => args[a.key] != null || args[a.name] != null)
        .map((a) => ({
          label: a.name,
          value: args[a.key] ?? args[a.name],
          type: "string" as const,
        }));

      initialPins = [...argPins, ...(input.startupPins ?? [])];
    }

    const cwd = input.directory ?? template.directory;
    const agent = await this.agentManager.createAgent({
      name: sanitizeAgentName(template.name),
      type: resolvedType,
      model: resolvedModel,
      cwd,
      initialPrompt: finalPrompt,
      launchContext: { links: !isTerminal ? (input.startupLinks ?? []) : [] },
      fullAccess: !isTerminal && template.fullAccess,
      ...(isTerminal
        ? { useWorktree: false }
        : templateWorktreeConfig(template)),
      initialPins,
      initialFiles: !isTerminal ? (input.startupFiles ?? []) : [],
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
