import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { createPr, getPrStatus } from "../github/pr.js";
import { toToolError } from "./tool-error.js";

export type PrToolContext = {
  defaultCwd: string | undefined;
  baseBranch: string | undefined;
};

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

export function registerPrTools(
  server: McpServer,
  allowed: Set<string>,
  context: PrToolContext
): void {
  const { defaultCwd } = context;
  const defaultBaseBranch = context.baseBranch || "main";

  if (allowed.has("create_pr")) {
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
          body: z
            .string()
            .optional()
            .describe(
              "Explicit PR body. Must not contain a Claude Code session link (claude.ai/code/session_...) — the repo may be public, and the call is rejected if the title or body does. Keep the Generated-with and Co-Authored-By lines."
            ),
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
}
