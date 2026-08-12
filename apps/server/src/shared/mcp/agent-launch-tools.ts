import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { CLI_AGENT_TYPES } from "../../agent-type-settings.js";
import { describeAgentModelCatalog } from "../agent-models.js";
import { toToolError } from "./tool-error.js";

export type LaunchAgentResult = {
  agentId: string;
  name: string;
  /** Set when a template arg was left empty. */
  note?: string;
};

export type LaunchAgentInput = {
  name: string;
  prompt: string;
  type?: string;
  model?: string;
  useWorktree?: boolean;
  createNewBranch?: boolean;
  baseBranch?: string;
  worktreeBranch?: string;
  fullAccess?: boolean;
  templateId?: string;
  templateArgs?: Record<string, string>;
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
          .describe(
            "Initial prompt describing what the agent should do. With templateId: if exactly one of the template's args is still unset, this text fills it; otherwise this text is appended after the rendered template prompt."
          ),
        type: z
          .enum(CLI_AGENT_TYPES)
          .optional()
          .describe(
            "Agent type. Defaults to the same type as the launching agent."
          ),
        model: z
          .string()
          .optional()
          .describe(
            "Model id for the new agent, matching its type. Omit to let the CLI use its default. " +
              describeAgentModelCatalog()
          ),
        useWorktree: z
          .boolean()
          .optional()
          .describe(
            "Create a new git worktree for the agent. Default: the template's setting when templateId is given, otherwise false (shares parent's worktree)."
          ),
        createNewBranch: z
          .boolean()
          .optional()
          .describe(
            "Create a new branch for the worktree. Default: true when a template supplies the worktree, otherwise false."
          ),
        baseBranch: z
          .string()
          .optional()
          .describe(
            "Branch to base the worktree on. Defaults to the template's base branch when templateId is given."
          ),
        worktreeBranch: z
          .string()
          .optional()
          .describe(
            "Explicit branch name for the worktree. Defaults to the template's branch name when templateId is given."
          ),
        fullAccess: z
          .boolean()
          .optional()
          .describe(
            "Run the agent with full tool access (no permission prompts). Defaults to the parent's setting."
          ),
        templateId: z
          .string()
          .optional()
          .describe(
            "Template to apply to the new agent. The agent gets the template's own prompt with its args filled in. Worktree settings (useWorktree/createNewBranch/baseBranch/worktreeBranch) fill in whatever you don't pass explicitly; model, fullAccess, and cwd are inherited from the launching agent regardless of the template."
          ),
        templateArgs: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Values for the template's args, keyed by arg name. Call get_template first — its `promptArgs` field lists them. Skip this when the template has one arg (your prompt fills it) or none. Args left unset render empty."
          ),
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
        if (args.model !== undefined) input.model = args.model;
        if (args.useWorktree !== undefined)
          input.useWorktree = args.useWorktree;
        if (args.createNewBranch !== undefined)
          input.createNewBranch = args.createNewBranch;
        if (args.baseBranch !== undefined) input.baseBranch = args.baseBranch;
        if (args.worktreeBranch !== undefined)
          input.worktreeBranch = args.worktreeBranch;
        if (args.fullAccess !== undefined) input.fullAccess = args.fullAccess;
        if (args.templateId !== undefined) input.templateId = args.templateId;
        if (args.templateArgs !== undefined)
          input.templateArgs = args.templateArgs;
        if (args.cwd !== undefined) input.cwd = args.cwd;

        const result = await launchAgent(agentId, input);
        const text = `Launched agent "${result.name}" (${result.agentId}).`;
        return {
          content: [
            {
              type: "text",
              text: result.note ? `${text} ${result.note}` : text,
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
