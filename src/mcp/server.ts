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

export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody?: unknown
): Promise<void> {
  const server = createDispatchMcpServer();
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

function createDispatchMcpServer(): McpServer {
  const server = new McpServer({
    name: "dispatch",
    version: "0.0.0"
  });

  server.registerTool(
    "create_worktree",
    {
      description: "Create a linked git worktree and branch from a repository checkout.",
      inputSchema: {
        cwd: z.string().describe("Absolute path inside the target git repository."),
        name: z.string().describe("Human-friendly work item name used to derive the branch when branchName is omitted."),
        branchName: z.string().optional().describe("Explicit branch name to create."),
        baseBranch: z.string().default("main").describe("Base branch or ref to branch from."),
        updateBase: z.boolean().default(true).describe("Fetch origin/<baseBranch> before creating the worktree."),
        worktreePath: z.string().optional().describe("Optional explicit absolute path for the new linked worktree.")
      }
    },
    async (args) => {
      try {
        const result = await createGitWorktree(args);
        return {
          content: [
            {
              type: "text",
              text: `Created worktree ${result.worktreeName} on branch ${result.branchName} at ${result.worktreePath}.`
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
        cwd: z.string().describe("Absolute path inside the linked worktree to clean up."),
        baseBranch: z.string().default("main").describe("Primary checkout branch to optionally fast-forward before cleanup."),
        updateBaseBranch: z.boolean().default(false).describe("Fetch and fast-forward the primary checkout on baseBranch before removing the worktree."),
        deleteBranch: z.boolean().default(false).describe("Delete the local branch after removing the linked worktree."),
        force: z.boolean().default(false).describe("Force removal and branch deletion when git requires it.")
      }
    },
    async (args) => {
      try {
        const result = await cleanupGitWorktree(args);
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
        cwd: z.string().describe("Absolute path inside the git repository."),
        baseBranch: z.string().default("main").describe("Base branch to target."),
        title: z.string().optional().describe("Explicit PR title."),
        body: z.string().optional().describe("Explicit PR body."),
        draft: z.boolean().default(false).describe("Create the PR as a draft."),
        fillFromCommits: z.boolean().default(false).describe("Let gh derive title/body from commits.")
      }
    },
    async (args) => {
      try {
        const result = await createPr(args);
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
        cwd: z.string().describe("Absolute path inside the git repository."),
        prNumber: z.number().int().positive().optional().describe("Specific PR number. Defaults to the PR for the current branch."),
        mergeMethod: z.enum(["squash", "merge", "rebase"]).default("squash").describe("Merge strategy to use once GitHub merges the PR."),
        deleteBranch: z.boolean().default(true).describe("Delete the branch after merge.")
      }
    },
    async (args) => {
      try {
        const result = await enablePrAutomerge(args);
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
        cwd: z.string().describe("Absolute path inside the git repository."),
        prNumber: z.number().int().positive().optional().describe("Specific PR number. Defaults to the PR for the current branch."),
        mergeMethod: z.enum(["squash", "merge", "rebase"]).default("squash").describe("Merge strategy to use."),
        deleteBranch: z.boolean().default(true).describe("Delete the branch after merge.")
      }
    },
    async (args) => {
      try {
        const result = await mergePrNow(args);
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
        cwd: z.string().describe("Absolute path inside the git repository."),
        prNumber: z.number().int().positive().optional().describe("Specific PR number. Defaults to the PR for the current branch.")
      }
    },
    async (args) => {
      try {
        const result = await getPrStatus(args);
        return {
          content: [{ type: "text", text: `PR #${result.number} is ${result.state} with merge state ${result.mergeStateStatus ?? "unknown"}.` }],
          structuredContent: result
        };
      } catch (error) {
        return toToolError(error);
      }
    }
  );

  return server;
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
