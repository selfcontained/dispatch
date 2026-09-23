import type { Pool } from "pg";

import type { AgentManager, AgentRecord } from "../agents/manager.js";
import {
  CLI_AGENT_TYPES,
  getEnabledAgentTypes,
  isCliAgentType,
} from "../agent-type-settings.js";
import { getBuiltInPersona } from "../personas/built-in.js";
import {
  assemblePersonaPrompt,
  loadPersonaBySlug,
  loadPersonas,
  type PersonaDefinition,
} from "../personas/loader.js";
import { buildPersonaReviewDiff } from "../personas/review-diff.js";
import {
  refreshRemoteBaseRef,
  resolveBaseRef,
} from "../shared/git/base-ref.js";
import {
  resolveRepoRoot,
  resolveWorktreeRoot,
} from "../shared/git/git-context.js";
import { validateAgentModel } from "../shared/agent-models.js";
import { getPrStatus } from "../shared/github/pr.js";
import { runCommand } from "../shared/lib/run-command.js";
import type { PublishUiEvent } from "./mcp-handler-types.js";

const CODEX_FULL_ACCESS_ARG = "--dangerously-bypass-approvals-and-sandbox";
const CLAUDE_FULL_ACCESS_ARG = "--dangerously-skip-permissions";

export type CreatePersonaHandlersDeps = {
  pool: Pool;
  agentManager: AgentManager;
  publishUiEvent: PublishUiEvent;
  withStreamFlag: (agent: AgentRecord) => AgentRecord & { hasStream: boolean };
};

export type PersonaLaunchOptions = {
  persona: string;
  /** The briefing the launcher wrote: what was built, what to look at. */
  context: string;
  agentType?: (typeof CLI_AGENT_TYPES)[number];
  /** Include a file-level map of the parent's changes (default true). */
  includeDiff?: boolean;
  model?: string;
  /** Display name; defaults to `<persona>-<parent suffix>`. */
  name?: string;
};

export type PreparedPersonaLaunch = {
  persona: PersonaDefinition;
  /** The persona's instructions, briefing and change map, as a system prompt. */
  prompt: string;
  agentType: (typeof CLI_AGENT_TYPES)[number];
  model: string | undefined;
  cwd: string;
  agentArgs: string[];
};

/**
 * A persona is a profile: instructions plus defaults, applied to an ordinary
 * launch. This resolves the profile against the parent's worktree (repo
 * personas win over built-ins), builds the change map when asked, and
 * returns everything `createAgent` needs. Nothing here is review-specific:
 * a QA persona, a docs persona and a reviewer all take this path.
 */
export function createPersonaHandlers(deps: CreatePersonaHandlersDeps) {
  const { pool, agentManager, publishUiEvent, withStreamFlag } = deps;

  async function preparePersonaLaunch(
    parent: AgentRecord,
    opts: PersonaLaunchOptions
  ): Promise<PreparedPersonaLaunch> {
    const fallbackReviewType = isCliAgentType(parent.reviewAgentType)
      ? parent.reviewAgentType
      : null;
    const fallbackParentType = isCliAgentType(parent.type)
      ? parent.type
      : "codex";
    const agentType: (typeof CLI_AGENT_TYPES)[number] =
      opts.agentType ?? fallbackReviewType ?? fallbackParentType;
    if (!CLI_AGENT_TYPES.includes(agentType)) {
      throw new Error(`Unsupported agent type "${agentType}".`);
    }
    const enabledAgentTypes = await getEnabledAgentTypes(pool);
    if (!enabledAgentTypes.includes(agentType)) {
      throw new Error(`${agentType} agents are disabled in settings.`);
    }
    const model = validateAgentModel(agentType, opts.model);

    const parentCwd = parent.worktreePath ?? parent.cwd;
    let personaRoot: string;
    try {
      personaRoot = await resolveWorktreeRoot(parentCwd);
    } catch {
      try {
        personaRoot = await resolveRepoRoot(parentCwd);
      } catch {
        throw new Error("Parent agent is not in a git repository.");
      }
    }
    let persona = await loadPersonaBySlug(personaRoot, opts.persona);
    if (!persona) {
      try {
        const repoRoot = await resolveRepoRoot(parentCwd);
        if (repoRoot !== personaRoot) {
          persona = await loadPersonaBySlug(repoRoot, opts.persona);
        }
      } catch {
        // No repo root either; the built-ins are the last resort.
      }
    }
    persona ??= getBuiltInPersona(opts.persona);
    if (!persona) {
      throw new Error(
        `Persona "${opts.persona}" not found in .dispatch/personas/ and is not a built-in persona.`
      );
    }

    const includeDiff = opts.includeDiff !== false;
    let diffResult = null;
    if (includeDiff) {
      let reviewBaseBranch: string | null =
        parent.baseBranch ??
        (parent.worktreePath && parent.worktreeBranch ? "main" : null);
      if (reviewBaseBranch == null) {
        try {
          const pr = await getPrStatus({ cwd: parentCwd }, runCommand);
          if (pr.baseRefName) reviewBaseBranch = pr.baseRefName;
        } catch {
          // No PR: fall through to the upstream fallback.
        }
      }
      const allowUpstreamFallback = reviewBaseBranch == null;
      await refreshRemoteBaseRef(parentCwd, reviewBaseBranch, {
        runCommand,
        allowUpstreamFallback,
      });
      const baseRef =
        (await resolveBaseRef(parentCwd, reviewBaseBranch, {
          runCommand,
          allowUpstreamFallback,
        })) ?? "origin/main";
      diffResult = await buildPersonaReviewDiff(parentCwd, baseRef, runCommand);
    }
    const prompt = assemblePersonaPrompt(persona, opts.context, diffResult, {
      includeDiff,
      agentType,
      parentAgentId: parent.id,
    });

    const agentArgs: string[] = ["--append-system-prompt", prompt];
    if (parent.fullAccess) {
      const fullAccessArg =
        agentType === "claude"
          ? CLAUDE_FULL_ACCESS_ARG
          : agentType === "codex"
            ? CODEX_FULL_ACCESS_ARG
            : null;
      if (fullAccessArg) agentArgs.push(fullAccessArg);
    }
    return { persona, prompt, agentType, model, cwd: parentCwd, agentArgs };
  }

  /**
   * Launch a child that runs as a persona, in the parent's worktree, in the
   * parent's stream, on its launch card. What the child does with its findings is the persona's
   * business: a reviewer posts a `review` block to the parent.
   */
  async function launchPersonaAgent(
    parentId: string,
    opts: PersonaLaunchOptions
  ): Promise<{ agentId: string; name: string; persona: string }> {
    const parent = await agentManager.getAgent(parentId);
    if (!parent) throw new Error("Parent agent not found.");
    if (parent.parentAgentId) {
      throw new Error(
        "This agent was itself launched as a child agent, and child agents cannot launch persona agents " +
          "(the UI only renders one level of sub agents). Ask the agent that launched you to run it, " +
          "or do this work in an independent agent (launch_agent with child: false)."
      );
    }
    const prepared = await preparePersonaLaunch(parent, opts);
    const agent = await agentManager.createAgent(
      {
        name: opts.name ?? `${opts.persona}-${parentId.slice(-6)}`,
        type: prepared.agentType,
        cwd: prepared.cwd,
        model: prepared.model,
        agentArgs: prepared.agentArgs,
        fullAccess: parent.fullAccess,
        useWorktree: false,
        persona: opts.persona,
        parentAgentId: parentId,
        launchedByAgentId: parentId,
        personaContext: opts.context,
        initialPrompt: buildPersonaKickoffPrompt(parentId),
        launchContext: { prompt: opts.context },
      },
      { detachLaunch: true }
    );
    const fresh = await agentManager.getAgent(agent.id);
    publishUiEvent({
      type: "agent.upsert",
      agent: withStreamFlag(fresh ?? agent),
    });
    return { agentId: agent.id, name: agent.name, persona: opts.persona };
  }

  async function listPersonas(
    agentCwd: string
  ): Promise<Array<{ slug: string; name: string; description: string }>> {
    const personas = await loadPersonas(agentCwd);
    return personas.map(({ slug, name, description }) => ({
      slug,
      name,
      description,
    }));
  }

  return { preparePersonaLaunch, launchPersonaAgent, listPersonas };
}

/** The first turn a persona agent receives: begin, and where to report. */
export function buildPersonaKickoffPrompt(parentAgentId: string): string {
  return [
    "Begin now. Your persona instructions, the launcher's briefing, and (when included) a map of the changes are already in your context.",
    `When you are done, post your result to the agent that launched you: post with to: "${parentAgentId}". A reviewer posts one \`review\` block (verdict, summary, findings); any other persona posts what its instructions say.`,
    "Later replies in that thread arrive as new prompts; answer in the thread (post with replyTo).",
  ].join("\n");
}
