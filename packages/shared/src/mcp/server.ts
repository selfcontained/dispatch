import type { IncomingMessage, ServerResponse } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";

import {
  createPr,
  enablePrAutomerge,
  getPrStatus,
  GitHubPrError,
  mergePrNow
} from "../github/pr.js";
import {
  GitWorktreeError,
  cleanupGitWorktree,
  createGitWorktree
} from "../git/worktree.js";
import { loadRepoTools, type RepoToolParam } from "./repo-tools.js";

export type McpAgent = { id: string; cwd: string };

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

export type PinInput = {
  label: string;
  value?: string;
  type?: "string" | "url" | "port" | "code" | "pr" | "filename";
  delete?: boolean;
};

export type McpRequestContext = {
  agent: McpAgent | null;
  repoRoot: string | null;
  worktreeRoot: string | null;
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

  server.registerTool(
    "create_worktree",
    {
      description: "Create a linked git worktree and branch from a repository checkout.",
      inputSchema: {
        cwd: cwdSchema(defaultCwd, "Absolute path inside the target git repository."),
        name: z.string().describe("Human-friendly work item name used to derive the branch when branchName is omitted."),
        branchName: z.string().optional().describe("Explicit branch name to create."),
        baseBranch: z.string().default("main").describe("Base branch or ref to branch from."),
        updateBase: z.boolean().default(true).describe("Fetch origin/<baseBranch> before creating the worktree."),
        worktreePath: z.string().optional().describe("Optional explicit absolute path for the new linked worktree.")
      }
    },
    async (args) => {
      try {
        const result = await createGitWorktree({
          ...args,
          cwd: resolveCwd(args.cwd, defaultCwd)
        });
        return {
          content: [
            {
              type: "text",
              text: `Created worktree ${result.worktreeName} on branch ${result.branchName} at ${result.worktreePath}. You MUST now cd into the worktree: cd ${result.worktreePath}`
            }
          ],
          structuredContent: result
        };
      } catch (error) {
        return toToolError(error);
      }
    }
  );

  server.registerTool(
    "cleanup_worktree",
    {
      description: "Remove a linked git worktree and optionally delete its branch or update the primary checkout base branch.",
      inputSchema: {
        cwd: cwdSchema(defaultCwd, "Absolute path inside the linked worktree to clean up."),
        baseBranch: z.string().default("main").describe("Primary checkout branch to optionally fast-forward before cleanup."),
        updateBaseBranch: z.boolean().default(false).describe("Fetch and fast-forward the primary checkout on baseBranch before removing the worktree."),
        deleteBranch: z.boolean().default(false).describe("Delete the local branch after removing the linked worktree."),
        force: z.boolean().default(false).describe("Force removal and branch deletion when git requires it.")
      }
    },
    async (args) => {
      try {
        const result = await cleanupGitWorktree({
          ...args,
          cwd: resolveCwd(args.cwd, defaultCwd)
        });
        return {
          content: [
            {
              type: "text",
              text: `Removed worktree ${result.worktreeName}${result.deletedBranch && result.branchName ? ` and deleted branch ${result.branchName}` : ""}.`
            }
          ],
          structuredContent: result
        };
      } catch (error) {
        return toToolError(error);
      }
    }
  );

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

  server.registerTool(
    "enable_pr_automerge",
    {
      description: "Enable GitHub auto-merge for a pull request once required checks pass.",
      inputSchema: {
        cwd: cwdSchema(defaultCwd, "Absolute path inside the git repository."),
        prNumber: z.number().int().positive().optional().describe("Specific PR number. Defaults to the PR for the current branch."),
        mergeMethod: z.enum(["squash", "merge", "rebase"]).default("squash").describe("Merge strategy to use once GitHub merges the PR.")
      }
    },
    async (args) => {
      try {
        const result = await enablePrAutomerge({
          ...args,
          cwd: resolveCwd(args.cwd, defaultCwd)
        });
        return {
          content: [{ type: "text", text: `Enabled auto-merge for PR ${result.prNumber ?? "current"} using ${result.mergeMethod}.` }],
          structuredContent: result
        };
      } catch (error) {
        return toToolError(error);
      }
    }
  );

  server.registerTool(
    "merge_pr_now",
    {
      description: "Merge a GitHub pull request immediately if it is mergeable right now.",
      inputSchema: {
        cwd: cwdSchema(defaultCwd, "Absolute path inside the git repository."),
        prNumber: z.number().int().positive().optional().describe("Specific PR number. Defaults to the PR for the current branch."),
        mergeMethod: z.enum(["squash", "merge", "rebase"]).default("squash").describe("Merge strategy to use.")
      }
    },
    async (args) => {
      try {
        const result = await mergePrNow({
          ...args,
          cwd: resolveCwd(args.cwd, defaultCwd)
        });
        return {
          content: [{ type: "text", text: `Merged PR ${result.prNumber ?? "current"} using ${result.mergeMethod}.` }],
          structuredContent: result
        };
      } catch (error) {
        return toToolError(error);
      }
    }
  );

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

  // TODO: Remove bin/dispatch-event and bin/dispatch-share once all agents use these MCP tools.
  if (context.agent && context.upsertEvent) {
    const agentId = context.agent.id;
    const upsertEvent = context.upsertEvent;

    server.registerTool(
      "dispatch_event",
      {
        description:
          "Report agent status to Dispatch. Must be called at the start of each turn (working), when blocked (blocked), waiting for user input (waiting_user), and before the final response (done or idle).",
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

  if (context.agent && context.upsertPin && context.deletePin) {
    const agentId = context.agent.id;
    const upsertPin = context.upsertPin;
    const deletePin = context.deletePin;

    server.registerTool(
      "dispatch_pin",
      {
        description:
          "Pin a key-value pair to the Dispatch UI for this agent. Pins are displayed in the sidebar so users can quickly find important info. To update a pin, set it again with the same label. To remove a pin, pass delete: true. " +
          "Good things to pin: dev server URLs (url), PR links (pr), key files changed (filename), test/build result summaries (string), DB migration names (string), relevant doc or issue links (url), architecture decisions or assumptions (string), the specific blocking question when in waiting_user state (string).",
        inputSchema: {
          label: z.string().max(100).describe("Display label for the pin (e.g. 'API Server', 'Vite Dev', 'DB Port')."),
          value: z
            .string()
            .max(2000)
            .optional()
            .describe("The value to display. Required unless delete is true."),
          type: z
            .enum(["string", "url", "port", "code", "pr", "filename"])
            .default("string")
            .describe("Value type. 'url' renders as a clickable link. 'port' renders as a monospace badge. 'code' renders as a monospace badge. 'pr' renders as a pull request link with a PR icon. 'filename' renders with a file icon in monospace. For list-like types (filename, url, string, port), separate multiple values with commas or newlines."),
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

  if (context.agent && context.shareMedia) {
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

  if (context.agent && context.submitFeedback) {
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

  if (context.agent && context.launchPersona) {
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

  if (context.agent && context.getFeedback) {
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

  if (context.agent && context.resolveFeedback) {
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

  const toolsRoot = context.worktreeRoot ?? context.repoRoot;
  if (context.agent && toolsRoot) {
    const repoTools = await loadRepoTools(toolsRoot);
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
