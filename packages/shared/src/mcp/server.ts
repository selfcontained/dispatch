import type { IncomingMessage, ServerResponse } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";

import {
  createPr,

  getPrStatus,
  GitHubPrError,
} from "../github/pr.js";
import {
  GitWorktreeError,
} from "../git/worktree.js";
import { loadRepoTools, type RepoToolParam } from "./repo-tools.js";

export type McpAgent = {
  id: string;
  cwd: string;
  persona?: string | null;
  parentAgentId?: string | null;
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

export type JobTools = {
  complete: (agentId: string, report: unknown) => Promise<{ runId: string; status: string }>;
  failed: (agentId: string, report: unknown) => Promise<{ runId: string; status: string }>;
  needsInput: (agentId: string, question: string) => Promise<{ runId: string; status: string }>;
  log: (
    agentId: string,
    input: { task: string; message: string; level: "debug" | "info" | "warn" | "error" }
  ) => Promise<{ runId: string; status: string }>;
  listAgents: () => Promise<Array<{ id: string; name: string; status: string; cwd: string }>>;
  listRecentPersonaReviews: (sinceDays: number) => Promise<Array<{
    id: number; agentId: string; parentAgentId: string; persona: string;
    status: string; message: string | null; verdict: string | null;
    summary: string | null; filesReviewed: string[] | null;
    createdAt: string; updatedAt: string;
  }>>;
  listRecentFeedback: (sinceDays: number) => Promise<Array<{
    id: number; agentId: string; persona: string; severity: string;
    filePath: string | null; lineNumber: number | null;
    description: string; suggestion: string | null;
    mediaRef: string | null; status: string; createdAt: string;
  }>>;
};

// ── Tool sets per agent type ──────────────────────────────────────────
// Each list defines which MCP tools are exposed to that agent type.
// To add a tool to an agent type, just add its name here.
const AGENT_TOOLS = new Set([
  "create_pr",
  "get_pr_status",
  "dispatch_event",
  "dispatch_notify",
  "dispatch_pin",
  "dispatch_share",
  "dispatch_feedback",
  "dispatch_launch_persona",
  "dispatch_get_feedback",
  "dispatch_resolve_feedback",
]);

const JOB_TOOLS = new Set([
  "create_pr",
  "get_pr_status",
  "dispatch_notify",
  "job_complete",
  "job_failed",
  "job_needs_input",
  "job_log",
  "list_agents",
  "list_recent_persona_reviews",
  "list_recent_feedback",
]);

const PERSONA_TOOLS = new Set([
  "review_status",
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
  media: Array<{ fileName: string; description: string | null; source: string; createdAt: string }>;
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
  sendNotify?: (
    agentId: string,
    input: NotifyInput
  ) => Promise<NotifyResult>;
  upsertEvent?: (
    agentId: string,
    event: { type: string; message: string; metadata?: Record<string, unknown> }
  ) => Promise<void>;
  shareMedia?: (
    agentId: string,
    opts: { filePath: string; description: string; source?: string; name?: string; update?: string }
  ) => Promise<MediaResult>;
  submitFeedback?: (
    agentId: string,
    feedback: FeedbackInput
  ) => Promise<{ id: number }>;
  launchPersona?: (
    agentId: string,
    opts: { persona: string; context: string }
  ) => Promise<{ agentId: string; persona: string; parentAgentId: string }>;
  getFeedback?: (
    agentId: string,
    opts: { persona?: string; limit?: number }
  ) => Promise<GetFeedbackResult>;
  resolveFeedback?: (
    agentId: string,
    feedbackId: number,
    status: "fixed" | "ignored"
  ) => Promise<FeedbackItem>;
  upsertPin?: (
    agentId: string,
    pin: { label: string; value: string; type: string }
  ) => Promise<void>;
  deletePin?: (
    agentId: string,
    label: string
  ) => Promise<void>;
  getParentContext?: (
    parentAgentId: string
  ) => Promise<ParentContextResult>;
  updateReviewStatus?: (
    agentId: string,
    input: { status: string; message?: string }
  ) => Promise<void>;
  completeReview?: (
    agentId: string,
    input: { verdict: string; summary: string; filesReviewed?: string[]; message?: string }
  ) => Promise<void>;
  jobTools?: JobTools;
  toolScope?: "agent" | "reviewer" | "job";
};

export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody?: unknown,
  context: McpRequestContext = { agent: null, repoRoot: null, worktreeRoot: null }
): Promise<void> {
  const server = await createDispatchMcpServer(context);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });
  res.once("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}

async function createDispatchMcpServer(context: McpRequestContext): Promise<McpServer> {
  const server = new McpServer({
    name: "dispatch",
    version: "0.0.0"
  });
  const defaultCwd = context.agent?.cwd ?? undefined;
  const agentType: AgentType = context.agent?.persona ? "persona" : context.jobTools ? "job" : "agent";
  const allowed = TOOL_SETS[agentType];

  // ── review_status (persona) ───────────────────────────────────────
  if (allowed.has("review_status") && context.updateReviewStatus && context.completeReview) {
    const agentId = context.agent!.id;
    const updateReviewStatus = context.updateReviewStatus;
    const completeReview = context.completeReview;

    server.registerTool(
      "review_status",
      {
        description:
          "Report review progress. Call with status 'reviewing' while actively reviewing code or testing. " +
          "Call with status 'complete' when the review is finished — include a verdict and summary.",
        inputSchema: {
          status: z.enum(["reviewing", "complete"]).describe("Current review status."),
          message: z.string().describe("Short description of current activity or final summary."),
          verdict: z
            .enum(["approve", "request_changes"])
            .optional()
            .describe("Review verdict. Required when status is 'complete'."),
          summary: z
            .string()
            .optional()
            .describe("Summary of the review findings. Required when status is 'complete'."),
          filesReviewed: z
            .array(z.string())
            .optional()
            .describe("List of file paths that were reviewed.")
        }
      },
      async (args) => {
        try {
          if (args.status === "complete") {
            if (!args.verdict) {
              return toToolError(new Error("verdict is required when status is 'complete'."));
            }
            if (!args.summary) {
              return toToolError(new Error("summary is required when status is 'complete'."));
            }
            await completeReview(agentId, {
              verdict: args.verdict,
              summary: args.summary,
              filesReviewed: args.filesReviewed,
              message: args.message
            });
            return {
              content: [{ type: "text", text: `Review complete: ${args.verdict}. ${args.summary}` }]
            };
          }

          await updateReviewStatus(agentId, {
            status: "reviewing",
            message: args.message
          });
          return {
            content: [{ type: "text", text: `Reviewing: ${args.message}` }]
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── get_parent_context (persona) ────────────────────────────────────
  if (allowed.has("get_parent_context") && context.agent?.parentAgentId && context.getParentContext) {
    const parentAgentId = context.agent.parentAgentId;
    const getParentContext = context.getParentContext;

    server.registerTool(
      "get_parent_context",
      {
        description:
          "Retrieve the parent agent's pins and shared media. Use this to discover dev server URLs, " +
          "key files, screenshots, and other context the parent agent has surfaced.",
        inputSchema: {}
      },
      async () => {
        try {
          const result = await getParentContext(parentAgentId);
          const parts: string[] = [];
          if (result.pins.length > 0) {
            parts.push("Pins:");
            for (const pin of result.pins) {
              parts.push(`  ${pin.label} (${pin.type}): ${pin.value}`);
            }
          } else {
            parts.push("No pins set by parent agent.");
          }
          if (result.media.length > 0) {
            parts.push("\nShared media:");
            for (const m of result.media) {
              parts.push(`  ${m.fileName}: ${m.description ?? "(no description)"}`);
            }
          }
          return {
            content: [{ type: "text", text: parts.join("\n") }],
            structuredContent: result
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── create_pr ─────────────────────────────────────────────────────
  if (allowed.has("create_pr")) {
    server.registerTool(
      "create_pr",
      {
        description: "Create a GitHub pull request for the current branch.",
        inputSchema: {
          cwd: cwdSchema(defaultCwd, "Absolute path inside the git repository."),
          baseBranch: z.string().default("main").describe("Base branch to target."),
          title: z.string().optional().describe("Explicit PR title."),
          body: z.string().optional().describe("Explicit PR body."),
          draft: z.boolean().default(false).describe("Create the PR as a draft."),
          fillFromCommits: z.boolean().default(false).describe("Let gh derive title/body from commits.")
        }
      },
      async (args) => {
        try {
          const result = await createPr({
            ...args,
            cwd: resolveCwd(args.cwd, defaultCwd)
          });
          return {
            content: [{ type: "text", text: `Created PR ${result.url} from ${result.branchName} into ${result.baseBranch}.` }],
            structuredContent: result
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
          cwd: cwdSchema(defaultCwd, "Absolute path inside the git repository."),
          prNumber: z.number().int().positive().optional().describe("Specific PR number. Defaults to the PR for the current branch.")
        }
      },
      async (args) => {
        try {
          const result = await getPrStatus({
            ...args,
            cwd: resolveCwd(args.cwd, defaultCwd)
          });
          return {
            content: [{ type: "text", text: `PR #${result.number} is ${result.state} with merge state ${result.mergeStateStatus ?? "unknown"}.` }],
            structuredContent: result
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
          type: z.enum(["working", "blocked", "waiting_user", "done", "idle"]).describe("The status event type."),
          message: z.string().describe("A short description of what is happening."),
          metadata: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Optional metadata object.")
        }
      },
      async (args) => {
        try {
          await upsertEvent(agentId, {
            type: args.type,
            message: args.message,
            metadata: args.metadata as Record<string, unknown> | undefined
          });
          return {
            content: [{ type: "text", text: `Updated ${agentId}: ${args.type} - ${args.message}` }]
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
          message: z.string().max(3000).describe("The notification message body. Supports Slack mrkdwn formatting (bold, links, lists, code blocks, etc). Max 3000 characters."),
          title: z.string().max(150).optional().describe("Optional title displayed above the message. Defaults to 'Notification from <agent>'. Max 150 characters."),
          level: z.enum(["info", "success", "warning", "error"]).default("info")
            .describe("Notification level — controls the color and emoji. info (blue), success (green), warning (amber), error (red)."),
          respectFocus: z.boolean().default(false)
            .describe("When true, the notification is suppressed if the user is actively viewing this agent in Dispatch. Default false — notifications are always sent."),
        }
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
            content: [{ type: "text", text: result.sent
              ? "Notification sent to Slack."
              : `Notification not sent: ${result.reason}` }]
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  if (allowed.has("dispatch_pin")) registerPinTool(server, context);
  if (allowed.has("dispatch_share")) registerShareTool(server, context);
  if (allowed.has("dispatch_feedback")) registerFeedbackTool(server, context);

  // ── dispatch_launch_persona ───────────────────────────────────────
  if (allowed.has("dispatch_launch_persona") && context.agent && context.launchPersona) {
    const agentId = context.agent.id;
    const launchPersona = context.launchPersona;

    server.registerTool(
      "dispatch_launch_persona",
      {
        description:
          "Launch a persona agent to review or test your current work. The persona runs in your working directory with specialized instructions. Available personas are defined in .dispatch/personas/ as markdown files.",
        inputSchema: {
          persona: z.string().describe("Name of the persona to launch (matches filename without .md extension, e.g. 'security-review')."),
          context: z.string().max(100_000).describe("Briefing for the persona — describe what you built, key files changed, and areas that need attention.")
        }
      },
      async (args) => {
        try {
          const result = await launchPersona(agentId, {
            persona: args.persona,
            context: args.context
          });
          return {
            content: [
              {
                type: "text",
                text: `Launched persona "${result.persona}" as agent ${result.agentId}.`
              }
            ]
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── dispatch_get_feedback ───────────────────────────────────────────
  if (allowed.has("dispatch_get_feedback") && context.agent && context.getFeedback) {
    const agentId = context.agent.id;
    const getFeedback = context.getFeedback;

    server.registerTool(
      "dispatch_get_feedback",
      {
        description:
          "Retrieve structured feedback submitted by persona agents you launched. Returns feedback grouped by persona. Only returns feedback from your direct child persona agents.",
        inputSchema: {
          persona: z
            .string()
            .optional()
            .describe("Filter to a specific persona by name. If omitted, returns feedback from all child personas."),
          limit: z
            .number()
            .int()
            .positive()
            .max(100)
            .default(100)
            .describe("Maximum number of feedback items to return. Defaults and caps at 100.")
        }
      },
      async (args) => {
        try {
          const result = await getFeedback(agentId, { persona: args.persona, limit: args.limit });
          const totalItems = result.personas.reduce((sum, p) => sum + p.feedback.length, 0);
          const summary = result.personas.length === 0
            ? "No persona feedback found."
            : `Found ${totalItems} feedback item(s) from ${result.personas.length} persona(s).`;
          return {
            content: [{ type: "text", text: summary }],
            structuredContent: result
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── dispatch_resolve_feedback ───────────────────────────────────────
  if (allowed.has("dispatch_resolve_feedback") && context.agent && context.resolveFeedback) {
    const agentId = context.agent.id;
    const resolveFeedback = context.resolveFeedback;

    server.registerTool(
      "dispatch_resolve_feedback",
      {
        description:
          "Resolve a persona feedback item by marking it as fixed or ignored. Use after retrieving feedback with dispatch_get_feedback to update the status of individual items.",
        inputSchema: {
          feedbackId: z
            .number()
            .int()
            .positive()
            .describe("The ID of the feedback item to resolve."),
          status: z
            .enum(["fixed", "ignored"])
            .describe("Resolution status: 'fixed' if addressed, 'ignored' if not applicable.")
        }
      },
      async (args) => {
        try {
          const result = await resolveFeedback(agentId, args.feedbackId, args.status);
          return {
            content: [{ type: "text", text: `Feedback #${result.id} marked as ${result.status}.` }]
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  // ── Job tools ──────────────────────────────────────────────────────
  if (allowed.has("job_complete") && context.agent && context.jobTools) {
    const agentId = context.agent.id;
    const jobTools = context.jobTools;
    const reportSchema = z.object({
      status: z.enum(["completed", "failed"]),
      summary: z.string().min(1),
      tasks: z.array(z.object({
        name: z.string().min(1),
        status: z.enum(["success", "skipped", "error"]),
        summary: z.string(),
        errors: z.array(z.object({
          message: z.string().min(1),
          recoverable: z.boolean().optional(),
          action: z.string().optional()
        })).optional()
      }))
    });

    server.registerTool(
      "job_complete",
      {
        description: "Submit the terminal structured report for a successful Dispatch job run.",
        inputSchema: {
          report: reportSchema.describe("Structured job report. report.status must be completed.")
        }
      },
      async (args) => {
        try {
          const result = await jobTools.complete(agentId, args.report);
          return { content: [{ type: "text", text: `Job run ${result.runId} marked ${result.status}.` }], structuredContent: result };
        } catch (error) {
          return toToolError(error);
        }
      }
    );

    server.registerTool(
      "job_failed",
      {
        description: "Submit the terminal structured report for a failed Dispatch job run.",
        inputSchema: {
          report: reportSchema.describe("Structured job report. report.status must be failed.")
        }
      },
      async (args) => {
        try {
          const result = await jobTools.failed(agentId, args.report);
          return { content: [{ type: "text", text: `Job run ${result.runId} marked ${result.status}.` }], structuredContent: result };
        } catch (error) {
          return toToolError(error);
        }
      }
    );

    server.registerTool(
      "job_needs_input",
      {
        description: "Pause a Dispatch job run when human input is required.",
        inputSchema: {
          question: z.string().min(1).describe("The question or decision needed from a human.")
        }
      },
      async (args) => {
        try {
          const result = await jobTools.needsInput(agentId, args.question);
          return { content: [{ type: "text", text: `Job run ${result.runId} marked ${result.status}.` }], structuredContent: result };
        } catch (error) {
          return toToolError(error);
        }
      }
    );

    server.registerTool(
      "job_log",
      {
        description: "Append structured progress for a task within the active Dispatch job run.",
        inputSchema: {
          task: z.string().min(1).describe("Task name this log entry belongs to."),
          message: z.string().min(1).describe("Progress message."),
          level: z.enum(["debug", "info", "warn", "error"]).default("info").describe("Log severity.")
        }
      },
      async (args) => {
        try {
          const result = await jobTools.log(agentId, args);
          return { content: [{ type: "text", text: `Logged progress for job run ${result.runId}.` }], structuredContent: result };
        } catch (error) {
          return toToolError(error);
        }
      }
    );

    server.registerTool(
      "list_agents",
      {
        description: "List all agents from this Dispatch server with their IDs, names, and statuses.",
        inputSchema: {}
      },
      async () => {
        try {
          const agents = await jobTools.listAgents();
          return {
            content: [{ type: "text", text: JSON.stringify({ agents }, null, 2) }],
            structuredContent: { agents }
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );

    server.registerTool(
      "list_recent_persona_reviews",
      {
        description: "List persona reviews from the last N days. Returns review metadata including persona type, status, verdict, and summary.",
        inputSchema: {
          since_days: z.number().int().min(1).max(90).default(7).describe("Number of days to look back (default 7, max 90).")
        }
      },
      async (args) => {
        try {
          const reviews = await jobTools.listRecentPersonaReviews(args.since_days);
          return {
            content: [{ type: "text", text: JSON.stringify({ reviews, count: reviews.length }, null, 2) }],
            structuredContent: { reviews, count: reviews.length }
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );

    server.registerTool(
      "list_recent_feedback",
      {
        description: "List feedback items submitted by persona agents in the last N days. Includes persona type, severity, description, status, and file location.",
        inputSchema: {
          since_days: z.number().int().min(1).max(90).default(7).describe("Number of days to look back (default 7, max 90).")
        }
      },
      async (args) => {
        try {
          const feedback = await jobTools.listRecentFeedback(args.since_days);
          return {
            content: [{ type: "text", text: JSON.stringify({ feedback, count: feedback.length }, null, 2) }],
            structuredContent: { feedback, count: feedback.length }
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  const toolsRoot = context.worktreeRoot ?? context.repoRoot;
  if (context.agent && toolsRoot) {
    const allRepoTools = await loadRepoTools(toolsRoot);
    const scope = context.toolScope ?? "agent";
    const repoTools = allRepoTools.filter((tool) => !tool.scope || tool.scope.includes(scope));
    for (const tool of repoTools) {
      const inputSchema = buildParamSchema(tool.params);
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema
        },
        async (args) => {
          try {
            const result = await tool.run({
              agentId: context.agent!.id,
              repoRoot: toolsRoot,
              params: args as Record<string, unknown>
            });
            return {
              content: [{ type: "text", text: result.message }],
              structuredContent: result
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
        label: z.string().max(100).describe("Display label for the pin (e.g. 'API Server', 'Vite Dev', 'DB Port')."),
        value: z
          .string()
          .max(2000)
          .optional()
          .describe("The value to display. Required unless delete is true."),
        type: z
          .enum(["string", "url", "port", "code", "pr", "filename", "markdown"])
          .default("string")
          .describe("Value type. 'url' renders as a clickable link. 'port' renders as a monospace badge. 'code' renders as a monospace badge. 'pr' renders as a pull request link with a PR icon. 'filename' renders with a file icon in monospace. 'markdown' renders constrained markdown for short summaries. For list-like types (filename, url, string, port), separate multiple values with commas or newlines."),
        delete: z
          .boolean()
          .default(false)
          .describe("Set to true to remove the pin with this label.")
      }
    },
    async (args) => {
      try {
        if (args.delete) {
          await deletePin(agentId, args.label);
          return {
            content: [{ type: "text", text: `Removed pin "${args.label}".` }]
          };
        }
        if (!args.value) {
          return toToolError(new Error("value is required when not deleting a pin."));
        }
        await upsertPin(agentId, {
          label: args.label,
          value: args.value,
          type: args.type ?? "string"
        });
        return {
          content: [{ type: "text", text: `Pinned "${args.label}": ${args.value}` }]
        };
      } catch (error) {
        return toToolError(error);
      }
    }
  );
}

function registerShareTool(server: McpServer, context: McpRequestContext): void {
  if (!context.agent || !context.shareMedia) return;
  const agentId = context.agent.id;
  const shareMedia = context.shareMedia;

  server.registerTool(
    "dispatch_share",
    {
      description:
        "Upload a media file or text snippet to Dispatch for sharing. Supports images (png/jpg/jpeg/gif/webp), video (mp4), and text files (txt/md/json/yaml/ts/py/go/rs/sh/sql/etc). Use source 'simulator' to capture from an iOS Simulator. For text snippets, pass content directly with a name (e.g. name='config.yaml') instead of writing to a file first. To update a previously shared file, pass its fileName (from the original response) in the 'update' parameter.",
      inputSchema: {
        filePath: z
          .string()
          .optional()
          .describe("Absolute path to the file to upload. Not required when source is 'simulator' or when content is provided."),
        content: z
          .string()
          .optional()
          .describe("Text content to share directly (max 32KB). Requires name param with a file extension (e.g. 'snippet.ts'). Use this for text snippets instead of writing to a temp file."),
        description: z.string().describe("A short description of the shared media."),
        source: z
          .enum(["screenshot", "simulator", "text"])
          .default("screenshot")
          .describe("The source type of the media. Automatically set to 'text' when sharing text files."),
        name: z
          .string()
          .optional()
          .describe("Preferred file name for the upload. Required when using content param. Derived from the file path if omitted."),
        simulatorUdid: z
          .string()
          .optional()
          .describe("Simulator UDID for simulator screenshots. Defaults to 'booted'."),
        update: z
          .string()
          .optional()
          .describe("fileName of an existing shared media file to update (returned from a previous dispatch_share call). When set, the file content is replaced instead of creating a new file.")
      }
    },
    async (args) => {
      try {
        let filePath = args.filePath;

        if (args.content !== undefined) {
          const MAX_CONTENT_BYTES = 32 * 1024;
          if (Buffer.byteLength(args.content, "utf-8") > MAX_CONTENT_BYTES) {
            return toToolError(new Error("content exceeds 32KB limit. Write to a file and use filePath instead."));
          }
          if (!args.name) {
            return toToolError(new Error("name is required when using content param (e.g. 'snippet.ts')."));
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
          await execFileAsync("xcrun", ["simctl", "io", udid, "screenshot", "--type=png", tmpPath]);
          filePath = tmpPath;
        }

        if (!filePath) {
          return toToolError(new Error("filePath is required when source is not 'simulator' and content is not provided."));
        }

        const result = await shareMedia(agentId, {
          filePath,
          description: args.description,
          source: args.source,
          name: args.name,
          update: args.update
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ],
          structuredContent: result
        };
      } catch (error) {
        return toToolError(error);
      }
    }
  );
}

function registerFeedbackTool(server: McpServer, context: McpRequestContext): void {
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
          .describe("File path relative to repo root where the issue was found."),
        lineNumber: z
          .number()
          .optional()
          .describe("Line number in the file."),
        description: z.string().describe("What was found — the issue or observation."),
        suggestion: z
          .string()
          .optional()
          .describe("Suggested fix or action to take."),
        mediaRef: z
          .string()
          .optional()
          .describe("Filename of a previously shared media file (from dispatch_share) to attach.")
      }
    },
    async (args) => {
      try {
        const result = await submitFeedback(agentId, {
          severity: args.severity,
          filePath: args.filePath,
          lineNumber: args.lineNumber,
          description: args.description,
          suggestion: args.suggestion,
          mediaRef: args.mediaRef
        });
        return {
          content: [{ type: "text", text: `Feedback #${result.id} submitted.` }]
        };
      } catch (error) {
        return toToolError(error);
      }
    }
  );
}

function cwdSchema(defaultCwd: string | undefined, description: string): z.ZodType<string | undefined> {
  const suffix = defaultCwd
    ? ` Defaults to the agent working directory (${defaultCwd}) when omitted on agent-scoped MCP routes.`
    : "";
  return defaultCwd ? z.string().optional().describe(`${description}${suffix}`) : z.string().describe(description);
}

function resolveCwd(value: string | undefined, defaultCwd: string | undefined): string {
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

function toToolError(error: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const message = error instanceof GitWorktreeError || error instanceof GitHubPrError
    ? error.message
    : error instanceof Error
      ? error.message
      : String(error);

  return {
    content: [
      {
        type: "text",
        text: message
      }
    ],
    isError: true
  };
}
