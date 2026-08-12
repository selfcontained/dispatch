import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { describeAgentModelCatalog } from "../agent-models.js";
import type { AgentType } from "../agent-types.js";
import { parseTemplateArgs } from "../../templates/arg-parser.js";
import { toToolError } from "./tool-error.js";

/**
 * Annotates a template with the variables parsed out of its prompt, so a caller
 * can see what to pass as dispatch_launch_agent's templateArgs without having
 * to recognise `{{D:...}}` syntax in the prompt text itself.
 */
function withTemplateArgs(template: unknown): unknown {
  if (!template || typeof template !== "object") return template;
  const prompt = (template as { prompt?: unknown }).prompt;
  if (typeof prompt !== "string") return template;
  return { ...template, args: parseTemplateArgs(prompt) };
}

const JOB_AGENT_TYPES = ["claude", "codex", "opencode", "cursor"] as const;
const TEMPLATE_AGENT_TYPES = [...JOB_AGENT_TYPES, "terminal"] as const;

const jobAgentTypeEnum = z.enum(JOB_AGENT_TYPES);
const templateAgentTypeEnum = z.enum(TEMPLATE_AGENT_TYPES);

// No return annotation: `z.ZodType<string | null | undefined>` erases the key's
// optionality, so inferred handler args would claim `model` is always present.
function modelSchema(
  mode: "create" | "update",
  agentTypes: readonly AgentType[]
) {
  const clearing =
    mode === "create" ? "" : " Pass null to clear a stored model.";
  return z
    .string()
    .nullable()
    .optional()
    .describe(
      `Model id, matching agentType. Omit to use the CLI default.${clearing} ` +
        describeAgentModelCatalog(agentTypes)
    );
}

export type CrudToolCallbacks = {
  listJobs: (directory?: string) => Promise<unknown>;
  getJobById: (jobId: string) => Promise<unknown>;
  getJobByName: (directory: string, name: string) => Promise<unknown>;
  createJob: (input: {
    name: string;
    directory: string;
    prompt?: string | null;
    schedule?: string | null;
    timeoutMs?: number;
    needsInputTimeoutMs?: number;
    agentType?: string;
    model?: string | null;
    useWorktree?: boolean;
    baseBranch?: string | null;
    branchName?: string | null;
    fullAccess?: boolean;
    autoArchive?: boolean;
    callable?: boolean;
    singleton?: boolean;
    enabled?: boolean;
    selfImprove?: boolean;
  }) => Promise<unknown>;
  updateJob: (input: {
    name: string;
    directory: string;
    displayName?: string;
    prompt?: string | null;
    schedule?: string | null;
    timeoutMs?: number;
    needsInputTimeoutMs?: number;
    agentType?: string;
    model?: string | null;
    useWorktree?: boolean;
    baseBranch?: string | null;
    branchName?: string | null;
    fullAccess?: boolean;
    autoArchive?: boolean;
    callable?: boolean;
    singleton?: boolean;
    enabled?: boolean;
    selfImprove?: boolean;
  }) => Promise<unknown>;
  deleteJob: (name: string, directory: string) => Promise<unknown>;
  runJob: (name: string, directory: string) => Promise<unknown>;
  listTemplates: (directory?: string) => Promise<unknown>;
  getTemplateById: (templateId: string) => Promise<unknown>;
  getTemplateByName: (directory: string, name: string) => Promise<unknown>;
  createTemplate: (input: {
    name: string;
    directory: string;
    description?: string | null;
    prompt?: string | null;
    agentType?: string;
    model?: string | null;
    useWorktree?: boolean;
    baseBranch?: string | null;
    branchName?: string | null;
    fullAccess?: boolean;
    callable?: boolean;
    allowMedia?: boolean;
    selfImprove?: boolean;
  }) => Promise<unknown>;
  updateTemplate: (
    templateId: string,
    input: {
      name?: string;
      directory?: string;
      description?: string | null;
      prompt?: string | null;
      agentType?: string;
      model?: string | null;
      useWorktree?: boolean;
      baseBranch?: string | null;
      branchName?: string | null;
      fullAccess?: boolean;
      callable?: boolean;
      allowMedia?: boolean;
      selfImprove?: boolean;
    }
  ) => Promise<unknown>;
  deleteTemplate: (templateId: string) => Promise<unknown>;
};

export function registerCrudTools(
  server: McpServer,
  allowed: Set<string>,
  opts: {
    defaultCwd: string | undefined;
    callbacks: CrudToolCallbacks;
  }
): void {
  const { defaultCwd, callbacks } = opts;

  function resolveDir(value: string | undefined): string {
    const dir = value?.trim() || defaultCwd?.trim();
    if (!dir) throw new Error("directory is required.");
    return dir;
  }

  function dirSchema(): z.ZodType<string | undefined> {
    const desc = defaultCwd
      ? `Working directory. Defaults to ${defaultCwd}.`
      : "Working directory (required).";
    return defaultCwd
      ? z.string().optional().describe(desc)
      : z.string().describe(desc);
  }

  // ── list_jobs ──────────────────────────────────────────────────
  if (allowed.has("list_jobs")) {
    server.registerTool(
      "list_jobs",
      {
        description:
          "List jobs, scoped to a directory. Defaults to the agent's working directory.",
        inputSchema: { directory: dirSchema() },
      },
      async (args) => {
        try {
          const result = await callbacks.listJobs(
            args.directory?.trim() || defaultCwd
          );
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── get_job ────────────────────────────────────────────────────
  if (allowed.has("get_job")) {
    server.registerTool(
      "get_job",
      {
        description:
          "Get a single job by ID or name. When using name, directory defaults to the agent's working directory.",
        inputSchema: {
          jobId: z
            .string()
            .optional()
            .describe("Job ID. Provide jobId or name, not both."),
          name: z
            .string()
            .optional()
            .describe("Job name. Used with directory for lookup."),
          directory: dirSchema(),
        },
      },
      async (args) => {
        try {
          if (!args.jobId && !args.name) {
            return toToolError(new Error("Provide either jobId or name."));
          }
          const result = args.jobId
            ? await callbacks.getJobById(args.jobId)
            : await callbacks.getJobByName(
                resolveDir(args.directory),
                args.name!
              );
          if (!result) return toToolError(new Error("Job not found."));
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── create_job ─────────────────────────────────────────────────
  if (allowed.has("create_job")) {
    server.registerTool(
      "create_job",
      {
        description:
          "Create a new job. Only name is required; everything else has sensible defaults.",
        inputSchema: {
          name: z.string().min(1).describe("Job name."),
          directory: dirSchema(),
          prompt: z.string().nullable().optional().describe("Job prompt."),
          schedule: z
            .string()
            .nullable()
            .optional()
            .describe("Cron expression for scheduled runs."),
          timeoutMs: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Execution timeout in milliseconds."),
          needsInputTimeoutMs: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Timeout for human input in milliseconds."),
          agentType: jobAgentTypeEnum
            .default("claude")
            .describe("Agent runtime type."),
          model: modelSchema("create", JOB_AGENT_TYPES),
          useWorktree: z
            .boolean()
            .default(false)
            .describe("Run in a git worktree."),
          baseBranch: z
            .string()
            .nullable()
            .optional()
            .describe("Base branch for worktree."),
          branchName: z
            .string()
            .nullable()
            .optional()
            .describe("Branch name for worktree."),
          fullAccess: z
            .boolean()
            .default(false)
            .describe("Grant full filesystem access."),
          autoArchive: z
            .boolean()
            .default(true)
            .describe("Auto-archive agent on completion."),
          callable: z
            .boolean()
            .default(false)
            .describe("Allow triggering via API."),
          singleton: z
            .boolean()
            .default(true)
            .describe("Only one active run at a time."),
          enabled: z
            .boolean()
            .default(false)
            .describe("Enable scheduled runs."),
          selfImprove: z
            .boolean()
            .default(false)
            .describe("Let agents improve this prompt after a run."),
        },
      },
      async (args) => {
        try {
          const result = await callbacks.createJob({
            ...args,
            directory: resolveDir(args.directory),
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── update_job ─────────────────────────────────────────────────
  if (allowed.has("update_job")) {
    server.registerTool(
      "update_job",
      {
        description:
          "Update an existing job. Identifies the job by name (+ directory). Only pass fields you want to change.",
        inputSchema: {
          name: z
            .string()
            .min(1)
            .describe("Current job name (identifies the job)."),
          directory: dirSchema(),
          displayName: z
            .string()
            .optional()
            .describe("New display name (to rename the job)."),
          prompt: z
            .string()
            .nullable()
            .optional()
            .describe("New prompt. Pass null to clear."),
          schedule: z
            .string()
            .nullable()
            .optional()
            .describe("New cron schedule. Pass null to clear."),
          timeoutMs: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Execution timeout in milliseconds."),
          needsInputTimeoutMs: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Timeout for human input in milliseconds."),
          agentType: jobAgentTypeEnum
            .optional()
            .describe("Agent runtime type."),
          model: modelSchema("update", JOB_AGENT_TYPES),
          useWorktree: z
            .boolean()
            .optional()
            .describe("Run in a git worktree."),
          baseBranch: z
            .string()
            .nullable()
            .optional()
            .describe("Base branch for worktree."),
          branchName: z
            .string()
            .nullable()
            .optional()
            .describe("Branch name for worktree."),
          fullAccess: z
            .boolean()
            .optional()
            .describe("Grant full filesystem access."),
          autoArchive: z
            .boolean()
            .optional()
            .describe("Auto-archive agent on completion."),
          callable: z
            .boolean()
            .optional()
            .describe("Allow triggering via API."),
          singleton: z
            .boolean()
            .optional()
            .describe("Only one active run at a time."),
          enabled: z.boolean().optional().describe("Enable scheduled runs."),
          selfImprove: z
            .boolean()
            .optional()
            .describe("Let agents improve this prompt after a run."),
        },
      },
      async (args) => {
        try {
          const result = await callbacks.updateJob({
            ...args,
            directory: resolveDir(args.directory),
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── delete_job ─────────────────────────────────────────────────
  if (allowed.has("delete_job")) {
    server.registerTool(
      "delete_job",
      {
        description:
          "Delete a job by name. Fails if the job has an active run.",
        inputSchema: {
          name: z.string().min(1).describe("Job name."),
          directory: dirSchema(),
        },
      },
      async (args) => {
        try {
          const result = await callbacks.deleteJob(
            args.name,
            resolveDir(args.directory)
          );
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── run_job ────────────────────────────────────────────────────
  if (allowed.has("run_job")) {
    server.registerTool(
      "run_job",
      {
        description:
          "Trigger a job run. Returns immediately with the run ID and agent ID.",
        inputSchema: {
          name: z.string().min(1).describe("Job name."),
          directory: dirSchema(),
        },
      },
      async (args) => {
        try {
          const result = await callbacks.runJob(
            args.name,
            resolveDir(args.directory)
          );
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── list_templates ─────────────────────────────────────────────
  if (allowed.has("list_templates")) {
    server.registerTool(
      "list_templates",
      {
        description:
          "List templates, scoped to a directory. Defaults to the agent's working directory. Each template's `args` field lists the variables its prompt expects.",
        inputSchema: { directory: dirSchema() },
      },
      async (args) => {
        try {
          const result = await callbacks.listTemplates(
            args.directory?.trim() || defaultCwd
          );
          const annotated = Array.isArray(result)
            ? result.map(withTemplateArgs)
            : result;
          return {
            content: [
              { type: "text", text: JSON.stringify(annotated, null, 2) },
            ],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── get_template ───────────────────────────────────────────────
  if (allowed.has("get_template")) {
    server.registerTool(
      "get_template",
      {
        description:
          "Get a single template by ID or name. When using name, directory defaults to the agent's working directory. The `args` field lists the variables its prompt expects — pass values for them as dispatch_launch_agent's templateArgs.",
        inputSchema: {
          templateId: z
            .string()
            .optional()
            .describe("Template ID. Provide templateId or name, not both."),
          name: z
            .string()
            .optional()
            .describe("Template name. Used with directory for lookup."),
          directory: dirSchema(),
        },
      },
      async (args) => {
        try {
          if (!args.templateId && !args.name) {
            return toToolError(new Error("Provide either templateId or name."));
          }
          const result = args.templateId
            ? await callbacks.getTemplateById(args.templateId)
            : await callbacks.getTemplateByName(
                resolveDir(args.directory),
                args.name!
              );
          if (!result) return toToolError(new Error("Template not found."));
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(withTemplateArgs(result), null, 2),
              },
            ],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── create_template ────────────────────────────────────────────
  if (allowed.has("create_template")) {
    server.registerTool(
      "create_template",
      {
        description:
          "Create a new template. Only name is required; everything else has sensible defaults.",
        inputSchema: {
          name: z.string().min(1).describe("Template name."),
          directory: dirSchema(),
          description: z
            .string()
            .nullable()
            .optional()
            .describe("Template description."),
          prompt: z.string().nullable().optional().describe("Template prompt."),
          agentType: templateAgentTypeEnum
            .default("claude")
            .describe("Agent runtime type."),
          model: modelSchema("create", TEMPLATE_AGENT_TYPES),
          useWorktree: z
            .boolean()
            .default(false)
            .describe("Run in a git worktree."),
          baseBranch: z
            .string()
            .nullable()
            .optional()
            .describe("Base branch for worktree."),
          branchName: z
            .string()
            .nullable()
            .optional()
            .describe("Branch name for worktree."),
          fullAccess: z
            .boolean()
            .default(false)
            .describe("Grant full filesystem access."),
          callable: z
            .boolean()
            .default(true)
            .describe("Show in Cmd+K launcher."),
          allowMedia: z
            .boolean()
            .default(true)
            .describe("Allow media attachments when launching."),
          selfImprove: z
            .boolean()
            .default(false)
            .describe("Let agents improve this prompt after a run."),
        },
      },
      async (args) => {
        try {
          const result = await callbacks.createTemplate({
            ...args,
            directory: resolveDir(args.directory),
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── update_template ────────────────────────────────────────────
  if (allowed.has("update_template")) {
    server.registerTool(
      "update_template",
      {
        description:
          "Update an existing template. Only pass fields you want to change.",
        inputSchema: {
          templateId: z.string().describe("Template ID."),
          name: z.string().optional().describe("New name."),
          directory: z.string().optional().describe("New directory."),
          description: z
            .string()
            .nullable()
            .optional()
            .describe("New description. Pass null to clear."),
          prompt: z
            .string()
            .nullable()
            .optional()
            .describe("New prompt. Pass null to clear."),
          agentType: templateAgentTypeEnum
            .optional()
            .describe("Agent runtime type."),
          model: modelSchema("update", TEMPLATE_AGENT_TYPES),
          useWorktree: z
            .boolean()
            .optional()
            .describe("Run in a git worktree."),
          baseBranch: z
            .string()
            .nullable()
            .optional()
            .describe("Base branch for worktree."),
          branchName: z
            .string()
            .nullable()
            .optional()
            .describe("Branch name for worktree."),
          fullAccess: z
            .boolean()
            .optional()
            .describe("Grant full filesystem access."),
          callable: z.boolean().optional().describe("Show in Cmd+K launcher."),
          allowMedia: z
            .boolean()
            .optional()
            .describe("Allow media attachments when launching."),
          selfImprove: z
            .boolean()
            .optional()
            .describe("Let agents improve this prompt after a run."),
        },
      },
      async (args) => {
        try {
          const { templateId, ...updates } = args;
          const result = await callbacks.updateTemplate(templateId, updates);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── delete_template ────────────────────────────────────────────
  if (allowed.has("delete_template")) {
    server.registerTool(
      "delete_template",
      {
        description: "Delete a template. Fails if any jobs reference it.",
        inputSchema: {
          templateId: z.string().describe("Template ID."),
        },
      },
      async (args) => {
        try {
          const result = await callbacks.deleteTemplate(args.templateId);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }
}
