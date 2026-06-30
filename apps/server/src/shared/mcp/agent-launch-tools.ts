import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { toToolError } from "./tool-error.js";

export type LaunchAgentResult = {
  agentId: string;
  name: string;
};

export type LaunchAgentInput = {
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
  cwd?: string;
};

export type AgentLaunchToolsContext = {
  agentId: string;
  launchAgent?: (
    agentId: string,
    input: LaunchAgentInput
  ) => Promise<LaunchAgentResult>;
};

export function registerAgentLaunchTools(
  server: McpServer,
  allowed: Set<string>,
  context: AgentLaunchToolsContext
): void {
  if (!allowed.has("dispatch_launch_agent") || !context.launchAgent) return;

  const agentId = context.agentId;
  const launchAgent = context.launchAgent;

  server.registerTool(
    "dispatch_launch_agent",
    {
      description:
        "Launch a new agent to work on a task. The new agent runs independently " +
        "— use dispatch_send_message to coordinate and list_agents to check status.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(100)
          .describe("Display name for the new agent."),
        prompt: z
          .string()
          .min(1)
          .max(100000)
          .describe("Initial prompt describing what the agent should do."),
        type: z
          .enum(["claude", "codex", "cursor", "opencode"])
          .optional()
          .describe(
            "Agent type. Defaults to the same type as the launching agent."
          ),
        useWorktree: z
          .boolean()
          .optional()
          .describe(
            "Create a new git worktree for the agent. Default: false (shares parent's worktree)."
          ),
        createNewBranch: z
          .boolean()
          .optional()
          .describe("Create a new branch for the worktree. Default: false."),
        baseBranch: z
          .string()
          .optional()
          .describe("Branch to base the worktree on."),
        worktreeBranch: z
          .string()
          .optional()
          .describe("Explicit branch name for the worktree."),
        fullAccess: z
          .boolean()
          .optional()
          .describe(
            "Run the agent with full tool access (no permission prompts). Defaults to the parent's setting."
          ),
        agentArgs: z
          .string()
          .optional()
          .describe("Additional CLI arguments passed to the agent."),
        templateId: z
          .string()
          .optional()
          .describe("Template to apply to the new agent."),
        cwd: z
          .string()
          .optional()
          .describe(
            "Working directory for the new agent. Defaults to the parent's working directory."
          ),
      },
    },
    async (args) => {
      try {
        const input: LaunchAgentInput = {
          name: args.name,
          prompt: args.prompt,
        };
        if (args.type !== undefined) input.type = args.type;
        if (args.useWorktree !== undefined)
          input.useWorktree = args.useWorktree;
        if (args.createNewBranch !== undefined)
          input.createNewBranch = args.createNewBranch;
        if (args.baseBranch !== undefined) input.baseBranch = args.baseBranch;
        if (args.worktreeBranch !== undefined)
          input.worktreeBranch = args.worktreeBranch;
        if (args.fullAccess !== undefined) input.fullAccess = args.fullAccess;
        if (args.agentArgs !== undefined) input.agentArgs = args.agentArgs;
        if (args.templateId !== undefined) input.templateId = args.templateId;
        if (args.cwd !== undefined) input.cwd = args.cwd;

        const result = await launchAgent(agentId, input);
        return {
          content: [
            {
              type: "text",
              text: `Launched agent "${result.name}" (${result.agentId}).`,
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
