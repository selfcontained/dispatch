import type { IncomingMessage, ServerResponse } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";

import type { AgentRecord } from "../agents/manager.js";
import {
  createPr,
  enablePrAutomerge,
  getPrStatus,
  GitHubPrError,
  mergePrNow
} from "../github/pr.js";
import { loadRepoTools } from "./repo-tools.js";

type McpRequestContext = {
  agent: AgentRecord | null;
  repoRoot: string | null;
};

export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody?: unknown,
  context: McpRequestContext = { agent: null, repoRoot: null }
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
        mergeMethod: z.enum(["squash", "merge", "rebase"]).default("squash").describe("Merge strategy to use once GitHub merges the PR."),
        deleteBranch: z.boolean().default(true).describe("Delete the branch after merge.")
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
        mergeMethod: z.enum(["squash", "merge", "rebase"]).default("squash").describe("Merge strategy to use."),
        deleteBranch: z.boolean().default(true).describe("Delete the branch after merge.")
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

  if (context.agent && context.repoRoot) {
    const repoTools = await loadRepoTools(context.repoRoot);
    for (const tool of repoTools) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: {}
        },
        async () => {
          try {
            const result = await tool.run({
              agentId: context.agent!.id,
              repoRoot: context.repoRoot!
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

function toToolError(error: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const message = error instanceof GitHubPrError
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
