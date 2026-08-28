import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { toToolError } from "./tool-error.js";

export type ArchiveAgentResult = {
  agentId: string;
  name: string;
  archiving: true;
};

export type ArchiveAgentInput = {
  agentId: string;
  cleanupWorktree?: "auto" | "keep" | "force";
  /**
   * Resolves once this call's response has been written. Teardown waits for it,
   * so an agent archiving itself is not killed before it reads the answer.
   */
  whenResponseFinished?: () => Promise<void>;
};

export type AgentArchiveToolsContext = {
  agentId: string;
  archiveAgent?: (
    agentId: string,
    input: ArchiveAgentInput
  ) => Promise<ArchiveAgentResult>;
  /** Per-request signal that the response has been written. */
  whenResponseFinished?: () => Promise<void>;
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
        "Archive an agent you launched (via dispatch_launch_agent or dispatch_launch_persona), " +
        "or yourself by passing your own agent ID. " +
        "Use this to clean up a sub-agent or review persona once its output has been consumed, or to " +
        "retire your own session once your work is finished and reported rather than idling until " +
        "someone archives you from outside. Archiving an agent you did not launch is rejected. " +
        "Stops the agent's session and soft-deletes it; this cannot be undone. " +
        "Any sub agents it launched with child: true are archived with it, along with their worktrees — " +
        "an agent launched with child: false is independent and is left running. " +
        "When the target is yourself, your session stops shortly after this returns — make it the last " +
        "thing you do, and send any final message or report first.",
      inputSchema: {
        agentId: z
          .string()
          .min(1)
          .describe(
            "ID of the agent to archive: one you launched, or your own ID to archive yourself."
          ),
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
          whenResponseFinished: context.whenResponseFinished,
        });
        return {
          content: [
            {
              type: "text",
              text:
                `Archiving agent "${result.name}" (${result.agentId}).` +
                (result.agentId === agentId
                  ? " This is your own session — it will stop momentarily."
                  : ""),
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
