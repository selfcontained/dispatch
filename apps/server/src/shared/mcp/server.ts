import type { IncomingMessage, ServerResponse } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";

import type { BrainStore } from "../../brain/store.js";
import { createPr, getPrStatus } from "../github/pr.js";
import { registerAnalyticsTools } from "./analytics-tools.js";
import { registerBrainTools } from "./brain-tools.js";
import { registerJobTools, type JobTools } from "./job-tools.js";
import {
  registerPersonaInteractionTools,
  type LaunchPersonaAgentType,
} from "./persona-interaction-tools.js";
import { registerPersonaTools } from "./persona-tools.js";
import { loadRepoTools, type RepoToolParam } from "./repo-tools.js";
import { toToolError } from "./tool-error.js";

export type McpAgent = {
  id: string;
  cwd: string;
  persona?: string | null;
  parentAgentId?: string | null;
  baseBranch?: string | null;
  review?: {
    allowRecheck?: boolean;
    status?: string | null;
  } | null;
};

export type MediaResult = {
  fileName: string;
  url: string;
  sizeBytes: number;
  source: string;
  description: string;
};

export type FeedbackInput = {
  severity?: "critical" | "high" | "medium" | "low" | "info";
  filePath?: string;
  lineNumber?: number;
  description: string;
  suggestion?: string;
  mediaRef?: string;
  respondsToFeedbackId?: number;
};

export type FeedbackItem = {
  id: number;
  severity: string;
  description: string;
  filePath: string | null;
  lineNumber: number | null;
  suggestion: string | null;
  mediaRef: string | null;
  status: string;
  roundNumber: number;
  respondsToFeedbackId: number | null;
  createdAt: string;
};

export type PersonaFeedbackGroup = {
  persona: string;
  agentId: string;
  feedback: FeedbackItem[];
};

export type GetFeedbackResult = {
  personas: PersonaFeedbackGroup[];
};

// ── Tool sets per agent type ──────────────────────────────────────────
// Each list defines which MCP tools are exposed to that agent type.
// To add a tool to an agent type, just add its name here.
const AGENT_TOOLS = new Set([
  "create_pr",
  "get_pr_status",
  "dispatch_event",
  "dispatch_rename_session",
  "dispatch_notify",
  "dispatch_pin",
  "dispatch_share",
  "dispatch_list_media",
  "dispatch_feedback",
  "list_personas",
  "dispatch_launch_persona",
  "dispatch_get_feedback",
  "dispatch_resolve_feedback",
  "dispatch_submit_resolution",
  "dispatch_cancel_recheck",
  "get_activity_summary",
  "get_agent_history",
  "get_feedback_summary",
  "brain_get_object",
  "brain_store_object",
  "brain_list_objects",
  "brain_delete_object",
  "brain_list_push",
  "brain_list_remove",
  "brain_list_get",
  "brain_list_set",
  "brain_list_delete",
  "brain_append_event",
  "brain_query_events",
]);

const JOB_TOOLS = new Set([
  "create_pr",
  "get_pr_status",
  "dispatch_event",
  "dispatch_rename_session",
  "dispatch_notify",
  "dispatch_pin",
  "dispatch_share",
  "dispatch_list_media",
  "dispatch_launch_persona",
  "dispatch_get_feedback",
  "dispatch_resolve_feedback",
  "dispatch_submit_resolution",
  "dispatch_cancel_recheck",
  "job_complete",
  "job_failed",
  "job_needs_input",
  "job_log",
  "list_agents",
  "list_personas",
  "list_recent_persona_reviews",
  "list_recent_feedback",
  "get_activity_summary",
  "get_agent_history",
  "get_feedback_summary",
  "brain_get_object",
  "brain_store_object",
  "brain_list_objects",
  "brain_delete_object",
  "brain_list_push",
  "brain_list_remove",
  "brain_list_get",
  "brain_list_set",
  "brain_list_delete",
  "brain_append_event",
  "brain_query_events",
]);

const PERSONA_TOOLS = new Set([
  "review_status",
  "dispatch_complete_review",
  "dispatch_get_recheck_context",
  "dispatch_event",
  "dispatch_pin",
  "dispatch_share",
  "dispatch_feedback",
  "get_parent_context",
]);

type AgentType = "agent" | "job" | "persona";
const TOOL_SETS: Record<AgentType, Set<string>> = {
  agent: AGENT_TOOLS,
  job: JOB_TOOLS,
  persona: PERSONA_TOOLS,
};

export type PinInput = {
  label: string;
  value?: string;
  type?: "string" | "url" | "port" | "code" | "pr" | "filename" | "markdown";
  delete?: boolean;
};

export type ReviewVerdict = "approve" | "request_changes";

export type ReviewCompletion = {
  verdict: ReviewVerdict;
  summary: string;
  filesReviewed?: string[];
};

export type ParentContextResult = {
  pins: Array<{ label: string; value: string; type: string }>;
  media: Array<{
    fileName: string;
    filePath: string;
    description: string | null;
    source: string;
    sizeBytes: number;
    createdAt: string;
  }>;
};

export type RecheckContextResult = {
  availability: "waiting_for_resolution" | "ready" | "complete" | "cancelled";
  reviewStatus: string;
  persona: string;
  reviewId: number;
  reviewRoundNumber: number | null;
  resolutionRoundNumber: number | null;
  resolutionSummary: string | null;
  lastReviewedCommit: string | null;
  resolutionCommit: string | null;
  compareRange: string | null;
  gitDiffCommand: string | null;
  submittedAt: string | null;
  resolutions: Array<{
    feedbackId: number;
    originalDescription: string;
    originalSeverity: string;
    status: string;
    reason: string | null;
    filePath: string | null;
    lineNumber: number | null;
    suggestion: string | null;
    resolutionCommit: string | null;
    resolvedAt: string | null;
    roundNumber: number;
  }>;
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

export type McpRequestContext = {
  agent: McpAgent | null;
  repoRoot: string | null;
  worktreeRoot: string | null;
  sendNotify?: (agentId: string, input: NotifyInput) => Promise<NotifyResult>;
  upsertEvent?: (
    agentId: string,
    event: { type: string; message: string; metadata?: Record<string, unknown> }
  ) => Promise<void>;
  renameSession?: (
    agentId: string,
    name: string
  ) => Promise<{ id: string; name: string }>;
  shareMedia?: (
    agentId: string,
    opts: {
      filePath: string;
      description: string;
      source?: string;
      name?: string;
      update?: string;
    }
  ) => Promise<MediaResult>;
  listMedia?: (
    agentId: string,
    opts: { source?: string }
  ) => Promise<
    Array<{
      fileName: string;
      filePath: string;
      source: string;
      description: string | null;
      sizeBytes: number;
      createdAt: string;
    }>
  >;
  submitFeedback?: (
    agentId: string,
    feedback: FeedbackInput
  ) => Promise<{ id: number }>;
  listPersonas?: (
    agentCwd: string
  ) => Promise<Array<{ slug: string; name: string; description: string }>>;
  launchPersona?: (
    agentId: string,
    opts: {
      persona: string;
      context: string;
      agentType?: LaunchPersonaAgentType;
      allowRecheck?: boolean;
      includeDiff?: boolean;
    }
  ) => Promise<{ agentId: string; persona: string; parentAgentId: string }>;
  getFeedback?: (
    agentId: string,
    opts: { persona?: string; limit?: number }
  ) => Promise<GetFeedbackResult>;
  resolveFeedback?: (
    agentId: string,
    feedbackId: number,
    status: "fixed" | "ignored",
    options?: { reason?: string | null }
  ) => Promise<FeedbackItem>;
  submitResolution?: (
    agentId: string,
    input: { personaAgentId: string; summary: string }
  ) => Promise<{
    review: { id: number; agentId: string; status: string };
    resolution: {
      id: number;
      reviewId: number;
      roundNumber: number;
      summary: string;
      resolutionCommit: string | null;
      submittedAt: string;
    };
  }>;
  upsertPin?: (
    agentId: string,
    pin: { label: string; value: string; type: string }
  ) => Promise<void>;
  deletePin?: (agentId: string, label: string) => Promise<void>;
  getParentContext?: (parentAgentId: string) => Promise<ParentContextResult>;
  getRecheckContext?: (agentId: string) => Promise<RecheckContextResult | null>;
  updateReviewStatus?: (
    agentId: string,
    input: { status: string; message?: string }
  ) => Promise<void>;
  completeReview?: (
    agentId: string,
    input: {
      verdict: string;
      summary: string;
      filesReviewed?: string[];
      message?: string;
    }
  ) => Promise<void>;
  cancelRecheck?: (
    agentId: string,
    input: { personaAgentId: string; reason?: string }
  ) => Promise<void>;
  getActivitySummary?: (params: {
    start: Date;
    end: Date;
    project?: string;
  }) => Promise<Record<string, unknown>>;
  getAgentHistory?: (params: {
    start: Date;
    end: Date;
    project?: string;
    limit: number;
    offset: number;
    includeEvents: boolean;
    includeFeedback: boolean;
    includeReviews: boolean;
    includeChildren: boolean;
  }) => Promise<Record<string, unknown>>;
  getFeedbackSummary?: (params: {
    start: Date;
    end: Date;
    project?: string;
    groupBy: "persona" | "severity" | "directory";
  }) => Promise<Record<string, unknown>>;
  jobTools?: JobTools;
  toolScope?: "agent" | "reviewer" | "job";
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

async function createDispatchMcpServer(
  context: McpRequestContext
): Promise<McpServer> {
  const server = new McpServer({
    name: "dispatch",
    version: "0.0.0",
  });
  const defaultCwd = context.agent?.cwd ?? undefined;
  const agentType: AgentType = context.agent?.persona
    ? "persona"
    : context.jobTools
      ? "job"
      : "agent";
  const allowed = new Set(TOOL_SETS[agentType]);

  // ── Persona / review lifecycle tools ────────────────────────────────
  if (context.agent) {
    registerPersonaTools(server, allowed, {
      agentId: context.agent.id,
      parentAgentId: context.agent.parentAgentId,
      allowRecheck: context.agent.review?.allowRecheck,
      updateReviewStatus: context.updateReviewStatus,
      completeReview: context.completeReview,
      getParentContext: context.getParentContext,
      getRecheckContext: context.getRecheckContext,
      cancelRecheck: context.cancelRecheck,
    });
  }

  // ── create_pr ─────────────────────────────────────────────────────
  if (allowed.has("create_pr")) {
    const agentBaseBranch = context.agent?.baseBranch;
    const defaultBaseBranch = agentBaseBranch || "main";
    server.registerTool(
      "create_pr",
      {
        description: "Create a GitHub pull request for the current branch.",
        inputSchema: {
          cwd: cwdSchema(
            defaultCwd,
            "Absolute path inside the git repository."
          ),
          baseBranch: z
            .string()
            .default(defaultBaseBranch)
            .describe("Base branch to target."),
          title: z.string().optional().describe("Explicit PR title."),
          body: z.string().optional().describe("Explicit PR body."),
          draft: z
            .boolean()
            .default(false)
            .describe("Create the PR as a draft."),
          fillFromCommits: z
            .boolean()
            .default(false)
            .describe("Let gh derive title/body from commits."),
        },
      },
      async (args) => {
        try {
          const result = await createPr({
            ...args,
            cwd: resolveCwd(args.cwd, defaultCwd),
          });
          return {
            content: [
              {
                type: "text",
                text: `Created PR ${result.url} from ${result.branchName} into ${result.baseBranch}.`,
              },
            ],
            structuredContent: result,
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── get_pr_status ─────────────────────────────────────────────────
  if (allowed.has("get_pr_status")) {
    server.registerTool(
      "get_pr_status",
      {
        description: "Fetch status details for a pull request.",
        inputSchema: {
          cwd: cwdSchema(
            defaultCwd,
            "Absolute path inside the git repository."
          ),
          prNumber: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Specific PR number. Defaults to the PR for the current branch."
            ),
        },
      },
      async (args) => {
        try {
          const result = await getPrStatus({
            ...args,
            cwd: resolveCwd(args.cwd, defaultCwd),
          });
          return {
            content: [
              {
                type: "text",
                text: `PR #${result.number} is ${result.state} with merge state ${result.mergeStateStatus ?? "unknown"}.`,
              },
            ],
            structuredContent: result,
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── dispatch_event ────────────────────────────────────────────────
  // dispatch_event and dispatch_share are implemented as native MCP tools below.
  if (allowed.has("dispatch_event") && context.agent && context.upsertEvent) {
    const agentId = context.agent.id;
    const upsertEvent = context.upsertEvent;

    server.registerTool(
      "dispatch_event",
      {
        description:
          "Report agent status to Dispatch. Must be called at the start of each turn (working), when stuck and unable to proceed (blocked), waiting for user input (waiting_user), and before the final response (done or idle).",
        inputSchema: {
          type: z
            .enum(["working", "blocked", "waiting_user", "done", "idle"])
            .describe("The status event type."),
          message: z
            .string()
            .describe("A short description of what is happening."),
          metadata: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Optional metadata object."),
        },
      },
      async (args) => {
        try {
          await upsertEvent(agentId, {
            type: args.type,
            message: args.message,
            metadata: args.metadata as Record<string, unknown> | undefined,
          });
          return {
            content: [
              {
                type: "text",
                text: `Updated ${agentId}: ${args.type} - ${args.message}`,
              },
            ],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── dispatch_rename_session ───────────────────────────────────────
  if (
    allowed.has("dispatch_rename_session") &&
    context.agent &&
    context.renameSession
  ) {
    const agentId = context.agent.id;
    const renameSession = context.renameSession;

    server.registerTool(
      "dispatch_rename_session",
      {
        description:
          "Update the current session's display name. Use this to rename a default-generated session to a short goal or topic, or when the user explicitly asks for a rename.",
        inputSchema: {
          name: z
            .string()
            .min(1)
            .max(120)
            .describe("New session display name."),
        },
      },
      async (args) => {
        try {
          const result = await renameSession(agentId, args.name);
          return {
            content: [
              { type: "text", text: `Renamed session to \"${result.name}\".` },
            ],
            structuredContent: result,
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── dispatch_notify ───────────────────────────────────────────────
  if (allowed.has("dispatch_notify") && context.agent && context.sendNotify) {
    const agentId = context.agent.id;
    const sendNotify = context.sendNotify;

    server.registerTool(
      "dispatch_notify",
      {
        description:
          "Send a Slack notification. Use this to proactively share summaries, results, or important updates " +
          "with the user via Slack. The message supports Slack mrkdwn formatting. " +
          "Requires a Slack webhook to be configured in Dispatch settings. " +
          "Rate limited to 5 messages per minute.",
        inputSchema: {
          message: z
            .string()
            .max(3000)
            .describe(
              "The notification message body. Supports Slack mrkdwn formatting (bold, links, lists, code blocks, etc). Max 3000 characters."
            ),
          title: z
            .string()
            .max(150)
            .optional()
            .describe(
              "Optional title displayed above the message. Defaults to 'Notification from <agent>'. Max 150 characters."
            ),
          level: z
            .enum(["info", "success", "warning", "error"])
            .default("info")
            .describe(
              "Notification level — controls the color and emoji. info (blue), success (green), warning (amber), error (red)."
            ),
          respectFocus: z
            .boolean()
            .default(false)
            .describe(
              "When true, the notification is suppressed if the user is actively viewing this agent in Dispatch. Default false — notifications are always sent."
            ),
        },
      },
      async (args) => {
        try {
          const result = await sendNotify(agentId, {
            message: args.message,
            title: args.title,
            level: args.level as NotifyInput["level"],
            respectFocus: args.respectFocus,
          });
          return {
            content: [
              {
                type: "text",
                text: result.sent
                  ? "Notification sent to Slack."
                  : `Notification not sent: ${result.reason}`,
              },
            ],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  if (allowed.has("dispatch_pin")) registerPinTool(server, context);
  if (allowed.has("dispatch_share")) registerShareTool(server, context);

  // ── dispatch_list_media ──────────────────────────────────────────
  if (
    allowed.has("dispatch_list_media") &&
    context.agent &&
    context.listMedia
  ) {
    const agentId = context.agent.id;
    const listMedia = context.listMedia;

    server.registerTool(
      "dispatch_list_media",
      {
        description:
          "List media files shared with or by this agent. Returns metadata only — use file reading tools to access content via filePath.",
        inputSchema: {
          source: z
            .string()
            .optional()
            .describe(
              'Optional source filter (e.g. "user", "screenshot", "text", "simulator", "stream"). Omit to list all media.'
            ),
        },
      },
      async (args) => {
        try {
          const items = await listMedia(agentId, { source: args.source });
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(items, null, 2) },
            ],
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  if (allowed.has("dispatch_feedback")) registerFeedbackTool(server, context);

  // ── Parent-side persona interaction tools ─────────────────────────
  if (context.agent) {
    registerPersonaInteractionTools(server, allowed, {
      agentId: context.agent.id,
      worktreeRoot: context.worktreeRoot,
      repoRoot: context.repoRoot,
      listPersonas: context.listPersonas,
      launchPersona: context.launchPersona,
      getFeedback: context.getFeedback,
      resolveFeedback: context.resolveFeedback,
      submitResolution: context.submitResolution,
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

  // ── Summary / analytics tools (available to both agents and jobs) ──
  registerAnalyticsTools(server, allowed, {
    getActivitySummary:
      context.getActivitySummary ?? context.jobTools?.getActivitySummary,
    getAgentHistory:
      context.getAgentHistory ?? context.jobTools?.getAgentHistory,
    getFeedbackSummary:
      context.getFeedbackSummary ?? context.jobTools?.getFeedbackSummary,
  });

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
            return {
              content: [{ type: "text", text: result.message }],
              structuredContent: result,
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

// ── Shared tool registrations (used by both persona and standard agents) ──

function registerPinTool(server: McpServer, context: McpRequestContext): void {
  if (!context.agent || !context.upsertPin || !context.deletePin) return;
  const agentId = context.agent.id;
  const upsertPin = context.upsertPin;
  const deletePin = context.deletePin;

  server.registerTool(
    "dispatch_pin",
    {
      description:
        "Pin a key-value pair to the Dispatch UI for this agent. Pins are displayed in the sidebar so users can quickly find important info. To update a pin, set it again with the same label. To remove a pin, pass delete: true. " +
        "Good things to pin: dev server URLs (url), PR links (pr), key files changed (filename), test/build result summaries (string), DB migration names (string), relevant doc or issue links (url), architecture decisions or assumptions (string), short structured summaries (markdown), the specific blocking question when in waiting_user state (string).",
      inputSchema: {
        label: z
          .string()
          .max(100)
          .describe(
            "Display label for the pin (e.g. 'API Server', 'Vite Dev', 'DB Port')."
          ),
        value: z
          .string()
          .max(2000)
          .optional()
          .describe("The value to display. Required unless delete is true."),
        type: z
          .enum(["string", "url", "port", "code", "pr", "filename", "markdown"])
          .default("string")
          .describe(
            "Value type. 'url' renders as a clickable link. 'port' renders as a monospace badge. 'code' renders as a monospace badge. 'pr' renders as a pull request link with a PR icon. 'filename' renders with a file icon in monospace. 'markdown' renders constrained markdown for short summaries. For list-like types (filename, url, string, port), separate multiple values with commas or newlines."
          ),
        delete: z
          .boolean()
          .default(false)
          .describe("Set to true to remove the pin with this label."),
      },
    },
    async (args) => {
      try {
        if (args.delete) {
          await deletePin(agentId, args.label);
          return {
            content: [{ type: "text", text: `Removed pin "${args.label}".` }],
          };
        }
        if (!args.value) {
          return toToolError(
            new Error("value is required when not deleting a pin.")
          );
        }
        await upsertPin(agentId, {
          label: args.label,
          value: args.value,
          type: args.type ?? "string",
        });
        return {
          content: [
            { type: "text", text: `Pinned "${args.label}": ${args.value}` },
          ],
        };
      } catch (error) {
        return toToolError(error);
      }
    }
  );
}

function registerShareTool(
  server: McpServer,
  context: McpRequestContext
): void {
  if (!context.agent || !context.shareMedia) return;
  const agentId = context.agent.id;
  const shareMedia = context.shareMedia;

  server.registerTool(
    "dispatch_share",
    {
      description:
        "Upload a media file or text snippet to Dispatch for sharing. Supports images (png/jpg/jpeg/gif/webp), video (mp4), documents (pdf), and text files (txt/md/json/yaml/ts/py/go/rs/sh/sql/etc). Use source 'simulator' to capture from an iOS Simulator. For text snippets, pass content directly with a name (e.g. name='config.yaml') instead of writing to a file first. To update a previously shared file, pass its fileName (from the original response) in the 'update' parameter.",
      inputSchema: {
        filePath: z
          .string()
          .optional()
          .describe(
            "Absolute path to the file to upload. Not required when source is 'simulator' or when content is provided."
          ),
        content: z
          .string()
          .optional()
          .describe(
            "Text content to share directly (max 32KB). Requires name param with a file extension (e.g. 'snippet.ts'). Use this for text snippets instead of writing to a temp file."
          ),
        description: z
          .string()
          .describe("A short description of the shared media."),
        source: z
          .enum(["screenshot", "simulator", "text"])
          .default("screenshot")
          .describe(
            "The source type of the media. Automatically set to 'text' when sharing text files."
          ),
        name: z
          .string()
          .optional()
          .describe(
            "Preferred file name for the upload. Required when using content param. Derived from the file path if omitted."
          ),
        simulatorUdid: z
          .string()
          .optional()
          .describe(
            "Simulator UDID for simulator screenshots. Defaults to 'booted'."
          ),
        update: z
          .string()
          .optional()
          .describe(
            "fileName of an existing shared media file to update (returned from a previous dispatch_share call). When set, the file content is replaced instead of creating a new file."
          ),
      },
    },
    async (args) => {
      try {
        let filePath = args.filePath;

        if (args.content !== undefined) {
          const MAX_CONTENT_BYTES = 32 * 1024;
          if (Buffer.byteLength(args.content, "utf-8") > MAX_CONTENT_BYTES) {
            return toToolError(
              new Error(
                "content exceeds 32KB limit. Write to a file and use filePath instead."
              )
            );
          }
          if (!args.name) {
            return toToolError(
              new Error(
                "name is required when using content param (e.g. 'snippet.ts')."
              )
            );
          }
          const { writeFile: writeFileTmp } = await import("node:fs/promises");
          const tmpDir = process.env.TMPDIR ?? "/tmp";
          const timestamp = new Date()
            .toISOString()
            .replace(/[:.]/g, "-")
            .replace("T", "-")
            .replace("Z", "");
          const tmpPath = `${tmpDir}/dispatch-text-${timestamp}-${args.name}`;
          await writeFileTmp(tmpPath, args.content, "utf-8");
          filePath = tmpPath;
        } else if (args.source === "simulator") {
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execFileAsync = promisify(execFile);
          const udid = args.simulatorUdid ?? "booted";
          const timestamp = new Date()
            .toISOString()
            .replace(/[:.]/g, "-")
            .replace("T", "-")
            .replace("Z", "");
          const tmpPath = `${process.env.TMPDIR ?? "/tmp"}/sim-${timestamp}.png`;
          await execFileAsync("xcrun", [
            "simctl",
            "io",
            udid,
            "screenshot",
            "--type=png",
            tmpPath,
          ]);
          filePath = tmpPath;
        }

        if (!filePath) {
          return toToolError(
            new Error(
              "filePath is required when source is not 'simulator' and content is not provided."
            )
          );
        }

        const result = await shareMedia(agentId, {
          filePath,
          description: args.description,
          source: args.source,
          name: args.name,
          update: args.update,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    }
  );
}

function registerFeedbackTool(
  server: McpServer,
  context: McpRequestContext
): void {
  if (!context.agent || !context.submitFeedback) return;
  const agentId = context.agent.id;
  const submitFeedback = context.submitFeedback;

  server.registerTool(
    "dispatch_feedback",
    {
      description:
        "Submit a structured feedback finding to Dispatch. Use this to report issues, suggestions, or observations about the code being reviewed. Each call creates one feedback item.",
      inputSchema: {
        severity: z
          .enum(["critical", "high", "medium", "low", "info"])
          .default("info")
          .describe("Severity level of the finding."),
        filePath: z
          .string()
          .optional()
          .describe(
            "File path relative to repo root where the issue was found."
          ),
        lineNumber: z.number().optional().describe("Line number in the file."),
        description: z
          .string()
          .describe("What was found — the issue or observation."),
        suggestion: z
          .string()
          .optional()
          .describe("Suggested fix or action to take."),
        mediaRef: z
          .string()
          .optional()
          .describe(
            "Filename of a previously shared media file (from dispatch_share) to attach."
          ),
        respondsToFeedbackId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Optional original feedback ID this follow-up finding responds to during a recheck round."
          ),
      },
    },
    async (args) => {
      try {
        const result = await submitFeedback(agentId, {
          severity: args.severity,
          filePath: args.filePath,
          lineNumber: args.lineNumber,
          description: args.description,
          suggestion: args.suggestion,
          mediaRef: args.mediaRef,
          respondsToFeedbackId: args.respondsToFeedbackId,
        });
        return {
          content: [
            { type: "text", text: `Feedback #${result.id} submitted.` },
          ],
        };
      } catch (error) {
        return toToolError(error);
      }
    }
  );
}

function cwdSchema(
  defaultCwd: string | undefined,
  description: string
): z.ZodType<string | undefined> {
  const suffix = defaultCwd
    ? ` Defaults to the agent working directory (${defaultCwd}) when omitted on agent-scoped MCP routes.`
    : "";
  return defaultCwd
    ? z.string().optional().describe(`${description}${suffix}`)
    : z.string().describe(description);
}

function resolveCwd(
  value: string | undefined,
  defaultCwd: string | undefined
): string {
  const cwd = value?.trim() || defaultCwd?.trim();
  if (!cwd) {
    throw new Error("cwd is required.");
  }
  return cwd;
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
