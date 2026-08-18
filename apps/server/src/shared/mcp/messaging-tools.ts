import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { AgentRelation } from "../../agents/lineage.js";
import { jsonText } from "./response.js";
import { toToolError } from "./tool-error.js";

export type AgentListing = {
  id: string;
  name: string;
  status: string;
  latestEvent: { type: string; message: string } | null;
  parentAgentId: string | null;
  parentName: string | null;
  /**
   * Present only when the launcher is not the parent — i.e. the agent was
   * launched with `child: false` and sits outside the launcher's lineage.
   */
  launchedByAgentId?: string;
  launchedByName?: string;
  relation: AgentRelation;
};

export type MessagingToolsContext = {
  agentId: string;
  repoRoot: string | null;
  listAgentsForAgent?: (
    agentId: string,
    senderRepoRoot: string | null
  ) => Promise<AgentListing[]>;
  sendMessage?: (
    agentId: string,
    input: { target: string; message: string; senderRepoRoot: string | null }
  ) => Promise<{
    delivered: boolean;
    targetAgentId: string;
    targetAgentName: string;
  }>;
};

export function registerMessagingTools(
  server: McpServer,
  allowed: Set<string>,
  context: MessagingToolsContext
): void {
  if (allowed.has("list_agents") && context.listAgentsForAgent) {
    const agentId = context.agentId;
    const listAgentsForAgent = context.listAgentsForAgent;

    server.registerTool(
      "list_agents",
      {
        description:
          "List other agents on this Dispatch server with their IDs, names, statuses, and latest activity. " +
          "Use this to discover agents you can communicate with via dispatch_send_message. " +
          "Each entry also carries its delegation lineage: parentAgentId/parentName name the agent that launched it, " +
          "and relation says how it sits relative to you (child, descendant, parent, ancestor, sibling, unrelated). " +
          "launchedByAgentId/launchedByName appear only when an agent was launched outside its launcher's lineage " +
          "(dispatch_launch_agent with child: false) — that agent is top-level, but the named launcher created it. " +
          "Build the delegation tree from parentAgentId rather than assuming the list is flat — a 'descendant' is a " +
          "grandchild or deeper, not something you launched yourself.",
        inputSchema: {},
      },
      async () => {
        try {
          const agents = await listAgentsForAgent(agentId, context.repoRoot);
          return {
            content: [{ type: "text", text: jsonText({ agents }) }],
            structuredContent: { agents },
          };
        } catch (error) {
          return toToolError(error);
        }
      }
    );
  }

  if (allowed.has("dispatch_send_message") && context.sendMessage) {
    const agentId = context.agentId;
    const sendMessage = context.sendMessage;

    server.registerTool(
      "dispatch_send_message",
      {
        description:
          "Send a message to another running agent. The message is injected into the target agent's session. " +
          "The target agent can reply using the same tool. Use list_agents to discover available agents. " +
          "Target can be an agent ID (agt_xxx) or a name (partial match). " +
          "Only works for agents that are currently running. " +
          "The recipient also sees your delegation chain (you, then each agent that launched you, up to them), " +
          "so it can tell a message from a direct child apart from one from further down the tree.",
        inputSchema: {
          target: z
            .string()
            .min(1)
            .describe(
              "Agent ID (agt_xxx) or name to send the message to. Names are fuzzy-matched against running agents."
            ),
          message: z
            .string()
            .min(1)
            .max(10000)
            .describe("The message content to send."),
        },
      },
      async (args) => {
        try {
          const result = await sendMessage(agentId, {
            target: args.target,
            message: args.message,
            senderRepoRoot: context.repoRoot,
          });
          return {
            content: [
              {
                type: "text",
                text: `Message delivered to "${result.targetAgentName}" (${result.targetAgentId}).`,
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
