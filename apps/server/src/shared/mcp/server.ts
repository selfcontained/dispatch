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
import { registerAgentLifecycleTools } from "./agent-lifecycle-tools.js";
import { registerAnalyticsTools } from "./analytics-tools.js";
import { registerBrainTools } from "./brain-tools.js";
import { registerCrudTools, type CrudToolCallbacks } from "./crud-tools.js";
import { registerJobTools, type JobTools } from "./job-tools.js";
import {
  registerMessagingTools,
  type AgentListing,
} from "./messaging-tools.js";
import { registerPersonalityTools } from "./personality-tools.js";
import { registerWhiteboardTools } from "./whiteboard-tools.js";
import type {
  WhiteboardGetResult,
  WhiteboardUpdateResult,
} from "../whiteboard.js";
import type { PinListing, PinSummary } from "../../server/pin-listing.js";
import {
  registerPersonaInteractionTools,
  type LaunchPersonaAgentType,
} from "./persona-interaction-tools.js";
import { registerPrTools } from "./pr-tools.js";
import { loadRepoTools, type RepoToolParam } from "./repo-tools.js";
import { VALID_PIN_SHORTCUT_ICONS } from "../../pins.js";
import { jsonText } from "./response.js";
import { toToolError } from "./tool-error.js";

/** One pin spec as an agent supplies it, shared by the single and batch tools. */
type McpPinInput = {
  id?: string;
  label: string;
  /** Omitted on an update means "keep the stored value". */
  value?: string;
  /** Omitted on an update means "keep the stored type". */
  type?: string;
  caption?: string;
  group?: string;
  icon?: string;
  variant?: string;
  confirm?: boolean;
  disabled?: boolean;
};

/**
 * The constrained field types every pin write shares. `dispatch_pin` and
 * `dispatch_pins` build their schemas from these and override only the
 * `.describe()` text — duplicating the *constraints* is how a raised cap ends
 * up enforced on one tool and silently not the other.
 */
const pinFields = {
  id: z.string().min(1),
  label: z.string().max(100),
  value: z.string().max(2000),
  type: z.enum([
    "string",
    "url",
    "port",
    "code",
    "pr",
    "filename",
    "markdown",
    "shortcut",
  ]),
  caption: z.string().max(160),
  /** A pin's own group. Must accept "" — that is how an agent clears it. */
  group: z.string().max(100),
  /**
   * A group named as the *target* of a bulk operation. Blank is rejected here
   * because a missing group compares equal to "", so an empty name would widen
   * "clear this group" into "delete every ungrouped pin".
   */
  scopingGroup: z.string().trim().min(1).max(100),
  icon: z.enum(VALID_PIN_SHORTCUT_ICONS),
  variant: z.enum(["default", "primary", "destructive"]),
  confirm: z.boolean(),
  disabled: z.boolean(),
} as const;

export type McpAgent = {
  id: string;
  cwd: string;
  type?: CliAgentType | null;
  role?: AgentRole | null;
  persona?: string | null;
  parentAgentId?: string | null;
  baseBranch?: string | null;
};

export type MediaResult = {
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
  "create_pr",
  "get_pr_status",
  "dispatch_event",
  "dispatch_rename_session",
  "dispatch_notify",
  "dispatch_pin",
  "dispatch_pins",
  "dispatch_delete_pin",
  "dispatch_share",
  "dispatch_list_media",
  "dispatch_delete_media",
  "dispatch_list_pins",
  "list_personas",
  "persona_templates",
  "persona_upsert",
  "persona_validate",
  "dispatch_launch_persona",
  "list_personalities",
  "create_personality",
  "update_personality",
  "delete_personality",
  "set_active_personality",
  "clear_active_personality",
  "dispatch_review_list_feedback",
  "dispatch_review_get_feedback",
  "dispatch_review_resolve",
  "dispatch_review_reopen",
  "dispatch_review_add_message",
  "list_agents",
  "dispatch_send_message",
  "dispatch_launch_agent",
  "dispatch_archive_agent",
  "get_activity_summary",
  "get_feedback_summary",
  "whiteboard_get",
  "whiteboard_update",
  "whiteboard_howto",
  "whiteboard_clear",
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
  "create_pr",
  "get_pr_status",
  "dispatch_event",
  "dispatch_rename_session",
  "dispatch_notify",
  "dispatch_pin",
  "dispatch_pins",
  "dispatch_delete_pin",
  "dispatch_share",
  "dispatch_list_media",
  "dispatch_delete_media",
  "dispatch_list_pins",
  "dispatch_launch_persona",
  "dispatch_review_list_feedback",
  "dispatch_review_get_feedback",
  "dispatch_review_resolve",
  "dispatch_review_reopen",
  "dispatch_review_add_message",
  "job_complete",
  "job_failed",
  "job_needs_input",
  "job_log",
  "list_agents",
  "dispatch_send_message",
  "dispatch_launch_agent",
  "dispatch_archive_agent",
  "list_personas",
  "persona_templates",
  "persona_upsert",
  "persona_validate",
  "get_activity_summary",
  "get_feedback_summary",
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

const REVIEW_AGENT_TOOLS = new Set([
  "dispatch_event",
  "dispatch_pin",
  "dispatch_pins",
  "dispatch_delete_pin",
  "dispatch_share",
  "dispatch_list_media",
  "dispatch_delete_media",
  "dispatch_list_pins",
  "dispatch_review_submit",
  "dispatch_review_add_feedback",
  "dispatch_review_list_feedback",
  "dispatch_review_get_feedback",
  "dispatch_review_add_message",
  "dispatch_review_resolve",
  "whiteboard_get",
]);

type AgentCapabilityType = "agent" | "job" | "review";
const TOOL_SETS: Record<AgentCapabilityType, Set<string>> = {
  agent: AGENT_TOOLS,
  job: JOB_TOOLS,
  review: REVIEW_AGENT_TOOLS,
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
  deleteMedia?: (agentId: string, fileName: string) => Promise<void>;
  listPins?: (agentId: string) => Promise<
    Array<{
      id: string;
      label: string;
      value: string;
      type: string;
      caption?: string;
      group?: string;
      icon?: string;
      variant?: string;
      confirm?: boolean;
    }>
  >;
  listPersonas?: (
    agentCwd: string
  ) => Promise<Array<{ slug: string; name: string; description: string }>>;
  launchPersona?: (
    agentId: string,
    opts: {
      persona: string;
      context: string;
      agentType?: LaunchPersonaAgentType;
      includeDiff?: boolean;
      model?: string;
    }
  ) => Promise<{ agentId: string; persona: string; parentAgentId: string }>;
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
    }
  ) => Promise<{ agentId: string; name: string; note?: string }>;
  archiveAgent?: (
    agentId: string,
    input: { agentId: string; cleanupWorktree?: "auto" | "keep" | "force" }
  ) => Promise<{ agentId: string; name: string; archived: true }>;
  resolveReviewFeedback?: (
    agentId: string,
    itemId: number,
    resolution: "fixed" | "dismissed",
    opts?: { note?: string | null }
  ) => Promise<{
    item: { id: number; reviewId: number; status: string; resolution: string };
    reviewStatus: string;
  }>;
  reopenReviewFeedback?: (
    agentId: string,
    itemId: number,
    opts?: { note?: string | null }
  ) => Promise<{
    item: { id: number; reviewId: number; status: string; resolution: null };
    reviewStatus: string;
  }>;
  submitReview?: (
    agentId: string,
    input: {
      summary?: string;
      feedback: Array<{
        filePath?: string;
        startLine?: number;
        endLine?: number;
        comment: string;
      }>;
    }
  ) => Promise<{
    review: {
      id: number;
      status: string;
      summary: string | null;
      items: Array<{ id: number }>;
    };
  }>;
  addReviewFeedback?: (
    agentId: string,
    input: {
      reviewId: number;
      filePath?: string;
      startLine?: number;
      endLine?: number;
      comment: string;
    }
  ) => Promise<{
    item: { id: number; reviewId: number };
    reviewStatus: string;
  }>;
  addReviewThreadMessage?: (
    agentId: string,
    itemId: number,
    body: string
  ) => Promise<{
    message: { id: number; feedbackItemId: number; content: { body: string } };
    reviewId: number;
  }>;
  listReviewFeedback?: (
    agentId: string,
    reviewId?: number
  ) => Promise<
    Array<{
      id: number;
      reviewId: number;
      filePath: string | null;
      lineStart: number | null;
      lineEnd: number | null;
      diffSnapshot: string | null;
      baseRef: string | null;
      status: string;
      resolution: string | null;
      resolutionNote: string | null;
      resolvedBy: string | null;
      resolvedAt: string | null;
      createdAt: string;
      updatedAt: string;
      messages: Array<{
        id: number;
        authorType: string;
        content: { body: string };
        createdAt: string;
      }>;
    }>
  >;
  getReviewFeedbackItem?: (
    agentId: string,
    itemId: number
  ) => Promise<Record<string, unknown> | null>;
  upsertPin?: (
    agentId: string,
    pin: McpPinInput
  ) => Promise<{ pin: PinListing; created: boolean }>;
  upsertPins?: (
    agentId: string,
    input: { pins: McpPinInput[]; mode?: "merge" | "replace"; group?: string }
  ) => Promise<PinSummary[]>;
  deletePin?: (
    agentId: string,
    input: { id?: string; ids?: string[]; group?: string }
  ) => Promise<void>;
  deletePinByLabel?: (agentId: string, label: string) => Promise<void>;
  getWhiteboard?: (agentId: string) => Promise<WhiteboardGetResult>;
  updateWhiteboard?: (
    agentId: string,
    elements: unknown[],
    deleteIds: string[]
  ) => Promise<WhiteboardUpdateResult>;
  clearWhiteboard?: (agentId: string) => Promise<void>;
  sendMessage?: (
    agentId: string,
    input: { target: string; message: string; senderRepoRoot: string | null }
  ) => Promise<{
    delivered: boolean;
    targetAgentId: string;
    targetAgentName: string;
  }>;
  listAgentsForAgent?: (
    agentId: string,
    senderRepoRoot: string | null
  ) => Promise<AgentListing[]>;
  getActivitySummary?: (params: {
    start: Date;
    end: Date;
    project?: string;
  }) => Promise<Record<string, unknown>>;
  getFeedbackSummary?: (params: {
    start: Date;
    end: Date;
    project?: string;
    groupBy: "persona" | "severity" | "directory";
  }) => Promise<Record<string, unknown>>;
  jobTools?: JobTools;
  crudTools?: CrudToolCallbacks;
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
  const agentType: AgentCapabilityType =
    context.agent?.role === "review"
      ? "review"
      : context.jobTools
        ? "job"
        : "agent";
  const allowed = new Set(TOOL_SETS[agentType]);

  // ── PR tools (create_pr, get_pr_status) ────────────────────────────
  registerPrTools(server, allowed, {
    defaultCwd,
    baseBranch: context.agent?.baseBranch ?? undefined,
  });

  // ── Agent lifecycle tools (dispatch_event, rename, notify, list_media) ──
  if (context.agent) {
    registerAgentLifecycleTools(server, allowed, {
      agentId: context.agent.id,
      upsertEvent: context.upsertEvent,
      renameSession: context.renameSession,
      sendNotify: context.sendNotify,
      listMedia: context.listMedia,
      deleteMedia: context.deleteMedia,
      listPins: context.listPins,
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

  if (allowed.has("dispatch_pin")) registerPinTool(server, context);
  if (allowed.has("dispatch_pins")) registerBatchPinTool(server, context);
  if (allowed.has("dispatch_delete_pin"))
    registerDeletePinTool(server, context);
  if (allowed.has("dispatch_share")) registerShareTool(server, context);
  // ── Persona launch and unified review tools ───────────────────────
  if (context.agent) {
    registerPersonaInteractionTools(server, allowed, {
      agentId: context.agent.id,
      parentAgentId: context.agent.parentAgentId,
      worktreeRoot: context.worktreeRoot,
      repoRoot: context.repoRoot,
      listPersonas: context.listPersonas,
      launchPersona: context.launchPersona,
      resolveReviewFeedback: context.resolveReviewFeedback,
      reopenReviewFeedback: context.reopenReviewFeedback,
      submitReview: context.submitReview,
      addReviewFeedback: context.addReviewFeedback,
      addReviewThreadMessage: context.addReviewThreadMessage,
      listReviewFeedback: context.listReviewFeedback,
      getReviewFeedbackItem: context.getReviewFeedbackItem,
    });
  }

  // ── Whiteboard tools ──────────────────────────────────────────────
  if (context.agent) {
    registerWhiteboardTools(server, allowed, {
      agentId: context.agent.id,
      getWhiteboard: context.getWhiteboard,
      updateWhiteboard: context.updateWhiteboard,
      clearWhiteboard: context.clearWhiteboard,
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
      sendMessage: context.sendMessage,
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

// ── Shared tool registrations (used by both persona and standard agents) ──

function registerPinTool(server: McpServer, context: McpRequestContext): void {
  if (!context.agent || !context.upsertPin) return;
  const agentId = context.agent.id;
  const upsertPin = context.upsertPin;
  const deletePinByLabel = context.deletePinByLabel;

  server.registerTool(
    "dispatch_pin",
    {
      description:
        "Pin a key-value pair to the Dispatch UI for this agent. Pins are displayed in the sidebar so users can quickly find important info. To update a pin, set it again with the same label — fields you omit keep their current value, so you can add a group or change a value without restating the rest; pass an empty string to clear caption, group, or icon. To rename a pin, pass its id from dispatch_list_pins along with the new label. To write several pins at once, use dispatch_pins instead of calling this repeatedly. To remove a pin, use dispatch_list_pins followed by dispatch_delete_pin. The delete parameter is retained temporarily only for agents that initialized before this tool upgrade. " +
        "Good things to pin: dev server URLs (url), PR links (pr), key files changed (filename), test/build result summaries (string), DB migration names (string), relevant doc or issue links (url), architecture decisions or assumptions (string), short structured summaries (markdown), the specific blocking question when in waiting_user state (string). " +
        "Use type 'shortcut' to give the user a one-click button that sends a prompt back to you — the label is the button text and the value is the prompt you receive when it is clicked. Good for offering the user a concrete next step (launch this work, re-run that check, pick this approach) instead of asking them to type it. When a shortcut pin is how the user answers a question that is blocking you, also emit a waiting_user event so the agent surfaces as needing attention — the pin is the answer mechanism, not the alert. " +
        "When a shortcut's action becomes temporarily or permanently unavailable but is still worth showing (e.g. its build already started elsewhere), set disabled: true instead of deleting it — the button greys out and stops accepting clicks. Set the caption to explain why (e.g. 'already building — agt_...'); it renders in place of the normal caption. Send disabled: false to re-enable it later.",
      inputSchema: {
        id: pinFields.id
          .optional()
          .describe(
            "Exact pin id from dispatch_list_pins. Pass it to edit that pin specifically — this is the only way to change a pin's label, since without an id the label is what identifies the pin. Omit to match by label."
          ),
        label: pinFields.label.describe(
          "Display label for the pin (e.g. 'API Server', 'Vite Dev', 'DB Port'). For shortcut pins this is the button text."
        ),
        value: pinFields.value
          .optional()
          .describe(
            "The value to display. For shortcut pins this is the prompt delivered to your session when the button is clicked. Required on a new pin; omit on an update to keep the stored value."
          ),
        type: pinFields.type
          .optional()
          .describe(
            "Value type, defaulting to 'string' on a new pin. Omit when updating an existing pin and its stored type is kept. 'url' renders as a clickable link. 'port' renders as a monospace badge. 'code' renders as a monospace badge. 'pr' renders as a pull request link with a PR icon. 'filename' renders with a file icon in monospace. 'markdown' renders constrained markdown for short summaries. 'shortcut' renders a button that sends `value` to your session when clicked. For list-like types (filename, url, string, port), separate multiple values with commas or newlines."
          ),
        caption: pinFields.caption
          .optional()
          .describe(
            "A one-line caption rendered under the pin, supporting inline markdown (bold, italic, `code`, strikethrough). Works on any pin type. On shortcut pins it is context for the click, not part of the injected prompt."
          ),
        group: pinFields.group
          .optional()
          .describe(
            "Renders this pin under a shared heading with every other pin using the same group name — use it to present a set of related actions, or the question they answer, as one block."
          ),
        icon: pinFields.icon
          .optional()
          .describe("Shortcut pins only: icon shown on the button."),
        variant: pinFields.variant
          .optional()
          .describe(
            "Shortcut pins only: button styling. 'primary' for the main suggested action, 'destructive' for dangerous ones, 'default' otherwise."
          ),
        confirm: pinFields.confirm
          .optional()
          .describe(
            "Shortcut pins only: when true, clicking asks the user to confirm and shows them the prompt first. Use for destructive or hard-to-undo actions."
          ),
        disabled: pinFields.disabled
          .optional()
          .describe(
            "Shortcut pins only: when true, the button renders non-interactive instead of being deleted — for an action that's temporarily or permanently unavailable but still worth showing. Pair with a caption explaining why. Send false to re-enable."
          ),
        delete: z
          .boolean()
          .optional()
          .describe("Deprecated compatibility option for deleting by label."),
      },
    },
    async (args) => {
      try {
        if (args.delete) {
          if (!deletePinByLabel) {
            return toToolError(
              new Error("Legacy pin deletion is unavailable.")
            );
          }
          await deletePinByLabel(agentId, args.label);
          return {
            content: [{ type: "text", text: `Removed pin \"${args.label}\".` }],
          };
        }
        const { created } = await upsertPin(agentId, {
          ...(args.id !== undefined ? { id: args.id } : {}),
          label: args.label,
          ...(args.value !== undefined ? { value: args.value } : {}),
          ...(args.type !== undefined ? { type: args.type } : {}),
          ...(args.caption !== undefined ? { caption: args.caption } : {}),
          ...(args.group !== undefined ? { group: args.group } : {}),
          ...(args.icon !== undefined ? { icon: args.icon } : {}),
          ...(args.variant !== undefined ? { variant: args.variant } : {}),
          ...(args.confirm !== undefined ? { confirm: args.confirm } : {}),
          ...(args.disabled !== undefined ? { disabled: args.disabled } : {}),
        });
        // Acknowledge the write without echoing the stored pin: the caller just
        // sent every field it set, and an update merges rather than replaces, so
        // the only thing it cannot infer is whether this created or updated —
        // which is exactly what it gets back. dispatch_list_pins remains the way
        // to check what an update actually carried over.
        return {
          content: [
            {
              type: "text",
              text: `${created ? "Created" : "Updated"} pin "${args.label}".`,
            },
          ],
        };
      } catch (error) {
        return toToolError(error);
      }
    }
  );
}

/**
 * The per-entry shape for `dispatch_pins`. Field semantics live on
 * `dispatch_pin` — restating them here would double what every agent pays in
 * context for the pin toolset, so this stays terse and points there.
 */
const batchPinEntrySchema = z.object({
  id: pinFields.id
    .optional()
    .describe("Pin id from dispatch_list_pins. Required to change a label."),
  label: pinFields.label.describe("Display label, or button text."),
  value: pinFields.value
    .optional()
    .describe(
      "Value, or the prompt for a shortcut. Required on a new pin; omit on an update to keep the stored value."
    ),
  type: pinFields.type
    .optional()
    .describe(
      "Defaults to 'string' on a new pin; omit on an update to keep the stored type. See dispatch_pin."
    ),
  caption: pinFields.caption.optional().describe("One-line caption."),
  group: pinFields.group
    .optional()
    .describe(
      "Shared heading. Ignored in replace mode, which files entries under its own group."
    ),
  icon: pinFields.icon.optional().describe("Shortcut pins only."),
  variant: pinFields.variant.optional().describe("Shortcut pins only."),
  confirm: pinFields.confirm.optional().describe("Shortcut pins only."),
  disabled: pinFields.disabled.optional().describe("Shortcut pins only."),
});

function registerBatchPinTool(
  server: McpServer,
  context: McpRequestContext
): void {
  if (!context.agent || !context.upsertPins) return;
  const agentId = context.agent.id;
  const upsertPins = context.upsertPins;

  server.registerTool(
    "dispatch_pins",
    {
      description:
        "Write several sidebar pins in one atomic call — use this instead of calling dispatch_pin in a loop. Each entry behaves exactly like dispatch_pin: it updates the pin matching its id (or, with no id, its label) and creates one otherwise, keeping any field you omit. Because an id survives a relabel, relabelling a whole set is one call here rather than a delete and recreate per pin. " +
        "Default mode 'merge' leaves pins you did not mention alone. Mode 'replace' requires a group and makes that group contain exactly the entries you pass, in the order you pass them — members you omit are deleted, and nothing outside the group is ever removed. Use replace to reorder a group or rewrite it wholesale; use merge for everything else. Returns the full resulting pin list.",
      inputSchema: {
        pins: z
          .array(batchPinEntrySchema)
          .min(1)
          .max(50)
          .describe("Pins to write, applied in order."),
        mode: z
          .enum(["merge", "replace"])
          .default("merge")
          .describe(
            "'merge' updates or creates each entry and touches nothing else. 'replace' rebuilds the named group to be exactly these entries."
          ),
        group: pinFields.scopingGroup
          .optional()
          .describe(
            "Required by mode 'replace': the only group the call may delete from. Entries are filed under it automatically."
          ),
      },
    },
    async (args) => {
      try {
        const pins = await upsertPins(agentId, {
          pins: args.pins,
          ...(args.mode !== undefined ? { mode: args.mode } : {}),
          ...(args.group !== undefined ? { group: args.group } : {}),
        });
        // Echo the resulting list, not the request: an agent can then see what
        // the batch actually produced — order included — rather than assuming
        // its input round-tripped. upsertPins returns summaries (id, label,
        // group), so this stays thin however long the stored values are; read
        // one back in full with dispatch_list_pins and its id.
        return {
          content: [
            {
              type: "text",
              text: `Wrote ${args.pins.length} pin(s). Pins are now: ${jsonText(pins)}`,
            },
          ],
        };
      } catch (error) {
        return toToolError(error);
      }
    }
  );
}

function registerDeletePinTool(
  server: McpServer,
  context: McpRequestContext
): void {
  if (!context.agent || !context.deletePin) return;
  const agentId = context.agent.id;
  const deletePin = context.deletePin;
  server.registerTool(
    "dispatch_delete_pin",
    {
      description:
        "Permanently remove sidebar pins. Pass exactly one of: 'id' for a single pin, 'ids' for several at once, or 'group' to clear an entire group. Call dispatch_list_pins first and pass exact returned ids.",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .optional()
          .describe("Exact pin id returned by dispatch_list_pins."),
        ids: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe(
            "Several exact pin ids, removed together. Every id must exist."
          ),
        group: pinFields.scopingGroup
          .optional()
          .describe("Remove every pin filed under this group heading."),
      },
    },
    async (args) => {
      try {
        await deletePin(agentId, {
          ...(args.id !== undefined ? { id: args.id } : {}),
          ...(args.ids !== undefined ? { ids: args.ids } : {}),
          ...(args.group !== undefined ? { group: args.group } : {}),
        });
        const removed = args.group
          ? `group "${args.group}"`
          : (args.ids ?? [args.id]).join(", ");
        return { content: [{ type: "text", text: `Removed ${removed}.` }] };
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
