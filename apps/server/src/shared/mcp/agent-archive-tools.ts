import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { toToolError } from "./tool-error.js";

export type ArchiveAgentResult = {
  agentId: string;
  name: string;
  archived: true;
};

export type ArchiveAgentInput = {
  agentId: string;
  cleanupWorktree?: "auto" | "keep" | "force";
};

export type AgentArchiveToolsContext = {
  agentId: string;
  archiveAgent?: (
    agentId: string,
    input: ArchiveAgentInput
  ) => Promise<ArchiveAgentResult>;
};

export function registerAgentArchiveTools(
  server: McpServer,
  allowed: Set<string>,
  context: AgentArchiveToolsContext
): void {
  if (!allowed.has("dispatch_archive_agent") || !context.archiveAgent) return;

  const agentId = context.agentId;
  const archiveAgent = context.archiveAgent;

  server.registerTool(
    "dispatch_archive_agent",
    {
      description:
        "Archive an agent you launched (via dispatch_launch_agent or dispatch_launch_persona). " +
        "Use this to clean up a sub-agent or review persona once its output has been consumed. " +
        "Scoped to direct children — archiving an agent you did not launch is rejected. " +
        "Stops the agent's session and soft-deletes it; this cannot be undone.",
      inputSchema: {
        agentId: z
          .string()
          .min(1)
          .describe("ID of the agent to archive. Must be one you launched."),
        cleanupWorktree: z
          .enum(["auto", "keep", "force"])
          .optional()
          .describe(
            "Worktree cleanup mode. 'auto' (default) removes the worktree only if it has no unmerged or uncommitted changes. 'keep' always preserves it. 'force' always removes it."
          ),
      },
    },
    async (args) => {
      try {
        const result = await archiveAgent(agentId, {
          agentId: args.agentId,
          cleanupWorktree: args.cleanupWorktree,
        });
        return {
          content: [
            {
              type: "text",
              text: `Archived agent "${result.name}" (${result.agentId}).`,
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
