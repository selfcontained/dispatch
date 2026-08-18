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
  location?: string;
  child?: boolean;
};

export type AgentLaunchToolsContext = {
  agentId: string;
  launchAgent?: (
    agentId: string,
    input: LaunchAgentInput
  ) => Promise<LaunchAgentResult>;
  /**
   * Pre-rendered sentence naming the linked instances, appended to `location`.
   * Computed per request by the caller — see describePeerLocations.
   */
  peerLocationHint?: string;
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
        "— use dispatch_send_message to coordinate and list_agents to check status. " +
        "By default the new agent is your child and appears under your card in the sidebar; " +
        "pass child: false to launch it as its own top-level agent instead.",
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
            "Initial prompt describing what the agent should do. With templateId: if exactly one of the template's args is still unset and every templateArgs key was recognized, this text fills it; otherwise this text is appended after the rendered template prompt."
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
            "Values for the template's args, keyed by arg name. Call get_template first — its `promptArgs` field lists them. Skip this when the template has one arg (your prompt fills it) or none. Args left unset render empty, and an unrecognized key suppresses the prompt-fills-one-arg shortcut."
          ),
        cwd: z
          .string()
          .optional()
          .describe(
            "Working directory for the new agent. Defaults to the parent's working directory. Required with location (the remote instance's path — it cannot be inherited across machines)."
          ),
        location: z
          .string()
          .optional()
          .describe(
            "Which machine to run the agent on, by the name shown in Linked Instances." +
              (context.peerLocationHint ?? "") +
              " Requires an explicit cwd (paths cannot be inherited across machines); calling with a location but no cwd returns the repos available there. Templates are not supported remotely. IMPORTANT: only the prompt you write crosses instances — the remote agent does not see your transcript, messages, or files, so write the prompt as a complete self-contained briefing."
          ),
        child: z
          .boolean()
          .optional()
          .describe(
            "Whether the new agent is your child (default true). A child appears as a sub agent row under your card. " +
              "Pass false to launch it as an independent top-level agent — it still inherits your working directory, " +
              "type, and access level, and you can still message and archive it, but it is not part of your lineage. " +
              "If you were launched as a child agent yourself, child: false is the only launch you can make."
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
        if (args.location !== undefined) input.location = args.location;
        if (args.child !== undefined) input.child = args.child;

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
