import { ProjectStore } from "../projects/store.js";
import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import type { SeedFileInput } from "../agents/file-seed.js";
import type { AgentManager } from "../agents/manager.js";
import type { AgentRecord } from "../agents/types.js";
import type { AgentType } from "../agent-type-settings.js";
import { resolveLaunchPersona } from "../personas/resolve.js";
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
  type AddTemplateInput,
  type TemplateRecord,
} from "./store.js";
import { templateWorktreeConfig } from "./worktree-config.js";
import { assertAccessCeiling } from "../shared/access-ceiling.js";

export type LaunchTemplateInput = {
  name?: string;
  templateId: string;
  args?: Record<string, string>;
  directory?: string;
  agentType?: AgentType;
  /** Per-launch override. Undefined keeps the template's saved model; null
   * forces the CLI default. */
  model?: string | null;
  startupFiles?: SeedFileInput[];
  /** Raw startup links, recorded as link attachments on the launch post. */
  startupLinks?: string[];
  /** Text appended after the rendered prompt, before any self-improve footer. */
  appendix?: string;
  /**
   * The project the agent joins. A project template always launches into its
   * own; a projectless one launches into this one when given.
   */
  projectId?: string | null;
};

export type LaunchResult = {
  agent: AgentRecord;
  templateId: string;
  templateName: string;
};

export class TemplateService {
  readonly store: TemplateStore;
  readonly projects: ProjectStore;

  constructor(
    pool: Pool,
    private readonly agentManager: AgentManager,
    private readonly logger: FastifyBaseLogger
  ) {
    this.store = new TemplateStore(pool);
    this.projects = new ProjectStore(pool);
  }

  async addTemplate(
    input: AddTemplateInput,
    callerFullAccess?: boolean
  ): Promise<TemplateRecord> {
    assertAccessCeiling(input.fullAccess ?? false, callerFullAccess);
    if (input.projectId) {
      const project = await this.projects.get(input.projectId);
      if (!project) throw new Error("Project not found.");
      input = { ...input, directory: project.repoRoot };
    }
    if (input.persona)
      await resolveLaunchPersona(
        input.directory,
        input.persona,
        "task",
        "catalog"
      );
    const template = await this.store.createTemplate({
      projectId: input.projectId ?? null,
      name: input.name.trim(),
      directory: input.directory,
      description: input.description ?? null,
      prompt: input.prompt ?? null,
      ...applyAgentConfigDefaults(input),
      callable: input.callable ?? true,
      allowFiles: input.allowFiles ?? true,
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
    input: Partial<AddTemplateInput>,
    callerFullAccess?: boolean
  ): Promise<TemplateRecord> {
    const existing = await this.store.getTemplate(id);
    if (!existing) throw new Error(`Template "${id}" not found.`);
    assertAccessCeiling(
      existing.fullAccess || input.fullAccess === true,
      callerFullAccess
    );
    const projectId =
      input.projectId === undefined ? existing.projectId : input.projectId;
    if (projectId) {
      const project = await this.projects.get(projectId);
      if (!project) throw new Error("Project not found.");
      input = { ...input, directory: project.repoRoot };
    }
    const persona =
      input.persona !== undefined ? input.persona : existing.persona;
    if (
      persona &&
      (persona !== existing.persona ||
        (input.directory !== undefined &&
          input.directory !== existing.directory))
    )
      await resolveLaunchPersona(
        input.directory ?? existing.directory,
        persona,
        "task",
        "catalog"
      );
    const updates: Parameters<TemplateStore["updateTemplate"]>[1] = {};
    if (input.persona !== undefined) updates.persona = input.persona;
    if (input.projectId !== undefined) updates.projectId = input.projectId;
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
    if (input.allowFiles !== undefined) updates.allowFiles = input.allowFiles;
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
    const resolvedModel =
      input.model !== undefined
        ? validateAgentModel(resolvedType, input.model ?? undefined)
        : resolvedType === template.agentType
          ? (template.model ?? undefined)
          : undefined;

    // A launch needs something to send or stand on: the saved prompt, the
    // caller's appendix (a task's briefing), or a persona's instructions.
    const hasPrompt = !!template.prompt?.trim();
    const hasAppendix = !!input.appendix?.trim();
    if (!hasPrompt && !hasAppendix && !template.persona) {
      throw new Error(
        `Template "${template.name}" has no prompt, persona, or task to launch with. Add a prompt or a persona, or launch it from a task (the task becomes its prompt).`
      );
    }
    if (
      !template.allowFiles &&
      ((input.startupFiles && input.startupFiles.length > 0) ||
        (input.startupLinks && input.startupLinks.length > 0))
    ) {
      throw new Error(
        `Template "${template.name}" does not allow file attachments.`
      );
    }

    // Without a saved prompt the appendix (a task's briefing) is the whole
    // prompt; with neither, the persona's instructions stand on their own.
    const finalPrompt = hasPrompt
      ? renderTemplatePrompt(
          { ...template, prompt: template.prompt ?? "" },
          input.args ?? {},
          input.appendix
        )
      : hasAppendix
        ? input.appendix
        : undefined;

    if (
      template.projectId &&
      input.directory &&
      input.directory !== template.directory
    )
      throw new Error("Project template directory cannot be overridden.");
    const cwd = input.directory ?? template.directory;
    const agent = await this.agentManager.createAgent({
      name: input.name?.trim() || sanitizeAgentName(template.name),
      type: resolvedType,
      model: resolvedModel,
      persona: template.persona ?? undefined,
      cwd,
      initialPrompt: finalPrompt,
      launchContext: {
        links: input.startupLinks ?? [],
      },
      fullAccess: template.fullAccess,
      ...templateWorktreeConfig(template),
      initialFiles: input.startupFiles ?? [],
      templateId: template.id,
      ...(input.projectId ? { projectId: input.projectId } : {}),
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
