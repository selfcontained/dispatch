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
   * Who created this session, as opposed to whose child it is. Present only
   * when the launcher is not already the parent — i.e. the agent was launched
   * with `child: false` and sits outside the launcher's lineage. Never
   * participates in `relation`, which is parent-tree-only.
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
          "Use this to discover agents you can reach with post (to: <agentId>). " +
          "Each entry carries two separate things. Lineage: parentAgentId/parentName name the agent this one is a " +
          "child of, and relation says how it sits relative to you in that same parent tree (child, descendant, " +
          "parent, ancestor, sibling, unrelated). Provenance: launchedByAgentId/launchedByName name whoever created " +
          "the session, and appear only when that is not already the parent — i.e. the agent was launched with " +
          "launch_agent's child: false, so it is top-level and reports as unrelated to you even though you " +
          "may have launched it. Build the delegation tree from parentAgentId rather than assuming the list is flat " +
          "— a 'descendant' is a grandchild or deeper, not something you launched yourself.",
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
}
