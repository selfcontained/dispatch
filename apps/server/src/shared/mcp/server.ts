import type { IncomingMessage, ServerResponse } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";

import type {
  AgentRole,
  AgentType as CliAgentType,
} from "../../agents/types.js";
import type { BrainStore } from "../../brain/store.js";
import { registerAgentArchiveTools } from "./agent-archive-tools.js";
import { registerAgentLaunchTools } from "./agent-launch-tools.js";
import {
  registerAgentLifecycleTools,
  type ListedFileItem,
} from "./agent-lifecycle-tools.js";
import { registerUsageTools, type UsageCallbacks } from "./usage-tools.js";
import { registerAnalyticsTools } from "./analytics-tools.js";
import { registerBrainTools } from "./brain-tools.js";
import { registerCrudTools, type CrudToolCallbacks } from "./crud-tools.js";
import { registerJobTools, type JobTools } from "./job-tools.js";
import { registerLoginLinkTools } from "./login-link-tools.js";
import {
  registerMessagingTools,
  type AgentListing,
} from "./messaging-tools.js";
import { registerPersonalityTools } from "./personality-tools.js";
import {
  registerPersonaInteractionTools,
  type LaunchPersonaAgentType,
} from "./persona-interaction-tools.js";
import { loadRepoTools, type RepoToolParam } from "./repo-tools.js";
import { jsonText } from "./response.js";
import { toToolError } from "./tool-error.js";
import { registerStreamTools } from "./stream-tools.js";
import type { StreamService } from "../../chat/service.js";

export type McpAgent = {
  id: string;
  cwd: string;
  type?: CliAgentType | null;
  role?: AgentRole | null;
  persona?: string | null;
  parentAgentId?: string | null;
  baseBranch?: string | null;
};

export type FileResult = {
  fileName: string;
  url: string;
  sizeBytes: number;
  source: string;
  description: string;
};

// ── Tool sets per agent type ──────────────────────────────────────────
// Each list defines which MCP tools are exposed to that agent type.
// To add a tool to an agent type, just add its name here.
const AGENT_TOOLS = new Set([
  "login_link",
  "rename_session",
  "list_files",
  "delete_file",
  "list_personas",
  "persona_templates",
  "persona_upsert",
  "persona_validate",
  "list_personalities",
  "create_personality",
  "update_personality",
  "delete_personality",
  "set_active_personality",
  "clear_active_personality",
  "list_agents",
  "launch_agent",
  "archive_agent",
  "post",
  "update",
  "react",
  "get_feedback_summary",
  "get_usage",
  "brain_get_object",
  "brain_store_object",
  "brain_list_objects",
  "brain_delete_object",
  "brain_list_push",
  "brain_list_remove",
  "brain_list_get",
  "brain_get_list_item",
  "brain_list_set",
  "brain_list_delete",
  "brain_append_event",
  "brain_query_events",
  "brain_get_event",
  "brain_delete_events",
  "list_jobs",
  "get_job",
  "create_job",
  "update_job",
  "delete_job",
  "run_job",
  "list_templates",
  "get_template",
  "create_template",
  "update_template",
  "delete_template",
]);

const JOB_TOOLS = new Set([
  "rename_session",
  "list_files",
  "delete_file",
  "job_complete",
  "job_failed",
  "job_needs_input",
  "job_log",
  "list_agents",
  "launch_agent",
  "archive_agent",
  "post",
  "update",
  "react",
  "list_personas",
  "persona_templates",
  "persona_upsert",
  "persona_validate",
  "get_feedback_summary",
  "get_usage",
  "brain_get_object",
  "brain_store_object",
  "brain_list_objects",
  "brain_delete_object",
  "brain_list_push",
  "brain_list_remove",
  "brain_list_get",
  "brain_get_list_item",
  "brain_list_set",
  "brain_list_delete",
  "brain_append_event",
  "brain_query_events",
  "brain_get_event",
  "brain_delete_events",
  "list_jobs",
  "get_job",
  "create_job",
  "update_job",
  "delete_job",
  "run_job",
  "list_templates",
  "get_template",
  "create_template",
  "update_template",
  "delete_template",
]);

type AgentCapabilityType = "agent" | "job";
const TOOL_SETS: Record<AgentCapabilityType, Set<string>> = {
  agent: AGENT_TOOLS,
  job: JOB_TOOLS,
};

export type NotifyInput = {
  message: string;
  title?: string;
  level?: "info" | "success" | "warning" | "error";
  respectFocus?: boolean;
};

export type NotifyResult = {
  sent: boolean;
  reason?: string;
};

/** The ephemeral SSE member every tool invocation publishes. */
export type ToolInvokedEvent = {
  type: "agent.tool_invoked";
  agentId: string;
  tool: string;
  at: string;
};

export type McpRequestContext = UsageCallbacks & {
  agent: McpAgent | null;
  repoRoot: string | null;
  worktreeRoot: string | null;
  /**
   * Publishes `agent.tool_invoked` for every tool call on this server
   * (dynamic repo tools included). Optional so
   * the token-less `/api/mcp` route and unit tests can omit it.
   */
  publishUiEvent?: (event: ToolInvokedEvent) => void;
  /** The stream: post / update / react. */
  chat?: Pick<
    StreamService,
    "post" | "update" | "addReaction" | "removeReaction"
  >;
  sendNotify?: (agentId: string, input: NotifyInput) => Promise<NotifyResult>;
  issueLoginLink?: () => string | Promise<string>;
  renameSession?: (
    agentId: string,
    name: string
  ) => Promise<{ id: string; name: string }>;
  shareFile?: (
    agentId: string,
    opts: {
      filePath: string;
      description: string;
      source?: string;
      name?: string;
      update?: string;
    }
  ) => Promise<FileResult>;
  listFiles?: (
    agentId: string,
    opts: { source?: string; ownerAgentId?: string }
  ) => Promise<ListedFileItem[]>;
  deleteFile?: (agentId: string, fileName: string) => Promise<void>;
  listPersonas?: (
    agentCwd: string
  ) => Promise<Array<{ slug: string; name: string; description: string }>>;
  listPersonalities?: () => Promise<{
    personalities: Array<{
      id: string;
      name: string;
      prompt: string;
      createdAt: string;
      updatedAt: string;
    }>;
    activeId: string | null;
  }>;
  createPersonality?: (input: { name: string; prompt: string }) => Promise<{
    id: string;
    name: string;
    prompt: string;
    createdAt: string;
    updatedAt: string;
  }>;
  updatePersonality?: (
    id: string,
    input: { name?: string; prompt?: string }
  ) => Promise<{
    id: string;
    name: string;
    prompt: string;
    createdAt: string;
    updatedAt: string;
  }>;
  deletePersonality?: (id: string) => Promise<void>;
  setActivePersonality?: (id: string) => Promise<void>;
  clearActivePersonality?: () => Promise<void>;
  launchAgent?: (
    agentId: string,
    input: {
      name: string;
      prompt: string;
      type?: string;
      useWorktree?: boolean;
      createNewBranch?: boolean;
      baseBranch?: string;
      worktreeBranch?: string;
      fullAccess?: boolean;
      agentArgs?: string;
      templateId?: string;
      templateArgs?: Record<string, string>;
      cwd?: string;
      child?: boolean;
    }
  ) => Promise<{ agentId: string; name: string; note?: string }>;
  archiveAgent?: (
    agentId: string,
    input: {
      agentId: string;
      cleanupWorktree?: "auto" | "keep" | "force";
      whenResponseFinished?: () => Promise<void>;
    }
  ) => Promise<{ agentId: string; name: string; archiving: true }>;
  /**
   * Resolves once this request's response has been written. Only the archive
   * tool uses it — it must not stop the caller's own session before the caller
   * has read the result.
   */
  whenResponseFinished?: () => Promise<void>;
  listAgentsForAgent?: (
    agentId: string,
    senderRepoRoot: string | null
  ) => Promise<AgentListing[]>;
  getFeedbackSummary?: (params: {
    start: Date;
    end: Date;
    project?: string;
    groupBy: "persona" | "severity" | "directory";
  }) => Promise<Record<string, unknown>>;
  jobTools?: JobTools;
  crudTools?: CrudToolCallbacks;
  toolScope?: "agent" | "job";
  brainStore?: BrainStore;
  publishBrainChanged?: (repoRoot: string) => void;
};

export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody?: unknown,
  context: McpRequestContext = {
    agent: null,
    repoRoot: null,
    worktreeRoot: null,
  }
): Promise<void> {
  const server = await createDispatchMcpServer(context);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.once("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}

/**
 * Wrap `registerTool` once so every tool this server ends up with — static
 * registrations and the dynamic repo tools alike — announces its invocation
 * before running. The publish is fenced: a broken listener must never turn
 * into a tool error.
 */
function instrumentToolInvocations(
  server: McpServer,
  agentId: string,
  publish: (event: ToolInvokedEvent) => void
): void {
  type AnyRegister = (
    name: string,
    config: unknown,
    callback: (...args: unknown[]) => unknown
  ) => unknown;
  const original = server.registerTool.bind(server) as unknown as AnyRegister;
  const instrumented: AnyRegister = (name, config, callback) =>
    original(name, config, (...args) => {
      {
        try {
          publish({
            type: "agent.tool_invoked",
            agentId,
            tool: name,
            at: new Date().toISOString(),
          });
        } catch {
          // Presence is best-effort; the tool call itself must proceed.
        }
      }
      return callback(...args);
    });
  (server as unknown as { registerTool: AnyRegister }).registerTool =
    instrumented;
}

export async function createDispatchMcpServer(
  context: McpRequestContext
): Promise<McpServer> {
  const server = new McpServer({
    name: "dispatch",
    version: "0.0.0",
  });
  if (context.agent && context.publishUiEvent) {
    instrumentToolInvocations(server, context.agent.id, context.publishUiEvent);
  }
  const defaultCwd = context.agent?.cwd ?? undefined;
  const agentType: AgentCapabilityType = context.jobTools ? "job" : "agent";
  const allowed = new Set(TOOL_SETS[agentType]);

  // ── Agent browser login link ─────────────────────────────────────
  registerLoginLinkTools(server, allowed, {
    issueLoginLink: context.issueLoginLink,
  });

  // ── Agent lifecycle tools (rename, notify, list_files) ──
  if (context.agent) {
    registerAgentLifecycleTools(server, allowed, {
      agentId: context.agent.id,
      renameSession: context.renameSession,
      sendNotify: context.sendNotify,
      listFiles: context.listFiles,
      deleteFile: context.deleteFile,
    });
  }

  // ── Personalities ────────────────────────────────────────────────
  registerPersonalityTools(server, allowed, {
    listPersonalities: context.listPersonalities,
    createPersonality: context.createPersonality,
    updatePersonality: context.updatePersonality,
    deletePersonality: context.deletePersonality,
    setActivePersonality: context.setActivePersonality,
    clearActivePersonality: context.clearActivePersonality,
  });

  // ── Persona tools (list, templates, authoring) ─────────────────────
  if (context.agent) {
    registerPersonaInteractionTools(server, allowed, {
      agentId: context.agent.id,
      parentAgentId: context.agent.parentAgentId,
      worktreeRoot: context.worktreeRoot,
      repoRoot: context.repoRoot,
      listPersonas: context.listPersonas,
    });
  }

  // ── Inter-agent messaging tools ───────────────────────────────────
  if (context.agent) {
    registerMessagingTools(server, allowed, {
      agentId: context.agent.id,
      repoRoot: context.repoRoot,
      // Job agents get list_agents via registerJobTools
      listAgentsForAgent: context.jobTools
        ? undefined
        : context.listAgentsForAgent,
    });
  }

  // ── Agent launch tools ───────────────────────────────────────────
  if (context.agent) {
    registerAgentLaunchTools(server, allowed, {
      agentId: context.agent.id,
      launchAgent: context.launchAgent,
    });
  }

  // ── Agent archive tools ───────────────────────────────────────────
  if (context.agent) {
    registerAgentArchiveTools(server, allowed, {
      agentId: context.agent.id,
      archiveAgent: context.archiveAgent,
      whenResponseFinished: context.whenResponseFinished,
    });
  }

  // ── Stream tools: post / update / react ──
  if (context.agent) {
    registerStreamTools(server, allowed, {
      agentId: context.agent.id,
      streams: context.chat,
    });
  }

  // ── Brain tools (shared memory for agents) ────────────────────────
  if (context.agent && context.repoRoot && context.brainStore) {
    const brainRepoRoot = context.repoRoot;
    registerBrainTools(server, allowed, {
      repoRoot: brainRepoRoot,
      agentId: context.agent.id,
      store: context.brainStore,
      publishBrainChanged: context.publishBrainChanged
        ? () => context.publishBrainChanged!(brainRepoRoot)
        : undefined,
    });
  }

  if (context.agent) registerUsageTools(server, allowed, context);

  // ── Summary / analytics tools (available to both agents and jobs) ──
  registerAnalyticsTools(server, allowed, {
    getFeedbackSummary:
      context.getFeedbackSummary ?? context.jobTools?.getFeedbackSummary,
  });

  // ── Job & template CRUD tools ─────────────────────────────────────
  if (context.crudTools) {
    registerCrudTools(server, allowed, {
      defaultCwd,
      callbacks: context.crudTools,
    });
  }

  // ── Job tools ──────────────────────────────────────────────────────
  if (allowed.has("job_complete") && context.agent && context.jobTools) {
    registerJobTools(server, context.agent.id, context.jobTools);
  }

  const toolsRoot = context.worktreeRoot ?? context.repoRoot;
  if (context.agent && toolsRoot) {
    const allRepoTools = await loadRepoTools(toolsRoot);
    const scope = context.toolScope ?? "agent";
    const repoTools = allRepoTools.filter(
      (tool) => !tool.scope || tool.scope.includes(scope)
    );
    for (const tool of repoTools) {
      const inputSchema = buildParamSchema(tool.params);
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema,
        },
        async (args) => {
          try {
            const result = await tool.run({
              agentId: context.agent!.id,
              repoRoot: toolsRoot,
              params: args as Record<string, unknown>,
            });
            // `message` is the command's stdout, which is already the text
            // content — carrying it in the structured payload too sent every
            // repo tool's output twice. Drop it, along with the agent id and
            // repo root the caller supplied in the first place.
            const {
              message,
              agentId: _agentId,
              repoRoot: _repoRoot,
              ...data
            } = result;
            return {
              content: [{ type: "text", text: message }],
              structuredContent: data,
            };
          } catch (error) {
            return toToolError(error);
          }
        }
      );
    }
  }

  return server;
}

function buildParamSchema(params?: RepoToolParam[]): Record<string, z.ZodType> {
  const schema: Record<string, z.ZodType> = {};
  if (!params) return schema;
  for (const param of params) {
    if (param.type === "boolean") {
      schema[param.name] = z.boolean().optional().describe(param.description);
    } else {
      schema[param.name] = z.string().optional().describe(param.description);
    }
  }
  return schema;
}
