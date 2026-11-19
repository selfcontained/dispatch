import { remotePlacement } from "@dispatch/runner-protocol";
import type { Effort } from "@dispatch/shared";
import { validateAgentEffort } from "../shared/agent-effort.js";
import { discoverPersonas, resolveLaunchPersona } from "../personas/resolve.js";
import type { Pool } from "pg";

import type { AgentManager, AgentRecord } from "../agents/manager.js";
import { agentWorkspaceDir } from "../agents/workspace-target.js";
import {
  CLI_AGENT_TYPES,
  getEnabledAgentTypes,
  isCliAgentType,
} from "../agent-type-settings.js";
import { getBuiltInPersona } from "../personas/built-in.js";
import {
  supportsPersonaType,
  assemblePersonaPrompt,
  buildStandardFeedbackGuidance,
  MAX_PERSONA_PROMPT_BYTES,
  loadPersonaFromCheckout,
  type PersonaDefinition,
} from "../personas/loader.js";
import {
  launchOwnerReviewPlan,
  parseCodeowners,
  resolveCodeowners,
  type OwnerReviewResult,
} from "../personas/codeowners.js";
import { LEGACY_OWNERS_PATH, OWNERS_PATH } from "../personas/paths.js";
import { validateAgentModel } from "../shared/agent-models.js";
import type { PublishUiEvent } from "./mcp-handler-types.js";

import { PERSONA_CONTEXT_ARG } from "../agents/acp/persona-context.js";

const CODEX_FULL_ACCESS_ARG = "--dangerously-bypass-approvals-and-sandbox";
const CLAUDE_FULL_ACCESS_ARG = "--dangerously-skip-permissions";

export type CreatePersonaHandlersDeps = {
  pool: Pool;
  agentManager: AgentManager;
  publishUiEvent: PublishUiEvent;
  withStreamFlag: (agent: AgentRecord) => AgentRecord & { hasStream: boolean };
};

async function readAgentCheckoutFile(
  manager: AgentManager,
  agent: AgentRecord,
  path: string
) {
  const reply = await manager.inspectCheckout(agent, {
    kind: "readFile",
    path,
  });
  if (reply.kind !== "readFile")
    throw new Error("Runner did not return the checkout file.");
  return reply.content;
}

export async function resolveRunnerPersona(
  manager: AgentManager,
  agent: AgentRecord,
  slug: string
) {
  const persona =
    (await loadPersonaFromCheckout(slug, (path) =>
      readAgentCheckoutFile(manager, agent, path)
    )) ?? getBuiltInPersona(slug);
  if (!persona)
    throw new Error(
      `Persona "${slug}" not found in this checkout or built-ins.`
    );
  if (!persona.body.trim())
    throw new Error(`Persona "${slug}" has no instructions.`);
  return persona;
}

export type PersonaLaunchOptions = {
  persona: string;
  /** The briefing the launcher wrote: what was built, what to look at. */
  context: string;
  agentType?: (typeof CLI_AGENT_TYPES)[number];
  model?: string;
  effort?: Effort | null;
  /** Internal: use a definition already selected by the caller. */
  resolvedPersona?: PersonaDefinition;
  /** Display name; defaults to `<persona>-<parent suffix>`. */
  name?: string;
};

export type PreparedPersonaLaunch = {
  persona: PersonaDefinition;
  /** The persona's instructions and briefing, delivered with the first ACP message. */
  prompt: string;
  agentType: (typeof CLI_AGENT_TYPES)[number];
  model: string | undefined;
  effort: Effort | null;
  cwd: string;
  agentArgs: string[];
  fullAccess: boolean;
};

/**
 * A persona is a profile: instructions plus defaults, applied to an ordinary
 * launch. This resolves the profile against the requester's worktree (repo
 * personas win over built-ins), assembles the briefing, and
 * returns everything `createAgent` needs. Nothing here is review-specific:
 * a QA persona, a docs persona and a reviewer all take this path.
 */
export function createPersonaHandlers(deps: CreatePersonaHandlersDeps) {
  const { pool, agentManager, publishUiEvent, withStreamFlag } = deps;

  async function preparePersonaLaunch(
    parent: AgentRecord,
    opts: PersonaLaunchOptions
  ): Promise<PreparedPersonaLaunch> {
    const cwd = agentWorkspaceDir(parent) ?? parent.cwd;
    return prepareReviewLaunch(
      parent,
      opts,
      cwd,
      parent.fullAccess,
      () =>
        opts.resolvedPersona ??
        resolveLaunchPersona(cwd, opts.persona, "review")
    );
  }

  async function prepareReviewLaunch(
    parent: AgentRecord,
    opts: PersonaLaunchOptions,
    cwd: string,
    fullAccess: boolean,
    resolvePersona: () => PersonaDefinition | Promise<PersonaDefinition>
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
    if (agentType === "opencode" && !parent.fullAccess) {
      throw new Error(
        "Permission denied: a restricted agent cannot launch full-access OpenCode agents."
      );
    }
    if (agentType === "opencode" && !fullAccess)
      throw new Error(
        "OpenCode requires full access and cannot run a restricted owner review."
      );
    const enabledAgentTypes = await getEnabledAgentTypes(pool);
    if (!enabledAgentTypes.includes(agentType)) {
      throw new Error(`${agentType} agents are disabled in settings.`);
    }
    const model = validateAgentModel(agentType, opts.model);
    const effort = validateAgentEffort(agentType, opts.effort, model);

    const persona = await resolvePersona();
    if (!supportsPersonaType(persona, "review"))
      throw new Error(
        `Persona "${opts.persona}" is not available for review launches.`
      );
    const prompt = assemblePersonaPrompt(persona, opts.context);

    const agentArgs: string[] = [
      "--append-system-prompt",
      buildStandardFeedbackGuidance(parent.id),
      PERSONA_CONTEXT_ARG,
      prompt,
    ];
    if (fullAccess) {
      const fullAccessArg =
        agentType === "claude"
          ? CLAUDE_FULL_ACCESS_ARG
          : agentType === "codex"
            ? CODEX_FULL_ACCESS_ARG
            : null;
      if (fullAccessArg) agentArgs.push(fullAccessArg);
    }
    return {
      persona,
      prompt,
      agentType,
      model,
      effort,
      cwd,
      agentArgs,
      fullAccess,
    };
  }

  /**
   * Launch a reviewer in the requester's worktree and shared stream, beside
   * the requester when it is a child. The launcher remains the feedback
   * recipient even when display lineage uses its parent.
   */
  async function launchPersonaAgent(
    parentId: string,
    opts: PersonaLaunchOptions
  ) {
    const parent = await agentManager.getAgent(parentId);
    if (!parent) throw new Error("Parent agent not found.");
    if (remotePlacement(parent.cwd)) {
      return launchReviewer(
        parent,
        opts,
        () =>
          prepareReviewLaunch(
            parent,
            opts,
            parent.cwd,
            false,
            () =>
              opts.resolvedPersona ??
              resolveRunnerPersona(agentManager, parent, opts.persona)
          ),
        parent.id
      );
    }
    return launchReviewer(parent, opts, () =>
      preparePersonaLaunch(parent, opts)
    );
  }

  async function launchReviewer(
    parent: AgentRecord,
    opts: PersonaLaunchOptions,
    prepare: () => Promise<PreparedPersonaLaunch>,
    useWorktreeOf?: string
  ): Promise<{
    agentId: string;
    name: string;
    persona: string;
    warnings?: string[];
  }> {
    const parentId = parent.id;
    // Lineage stays flat for display. The requester owns the checkout,
    // provenance and feedback even when it has a display parent.
    const displayParentId = parent.parentAgentId ?? parentId;
    if (parent.parentAgentId) {
      const displayParent = await agentManager.getAgent(displayParentId);
      if (!displayParent || displayParent.projectId !== parent.projectId)
        throw new Error(
          "Review display parent must belong to the requester's project."
        );
    }
    const prepared = await prepare();
    const agent = await agentManager.createAgent(
      {
        name: opts.name ?? `${opts.persona}-${parentId.slice(-6)}`,
        type: prepared.agentType,
        cwd: prepared.cwd,
        model: prepared.model,
        effort: prepared.effort,
        agentArgs: prepared.agentArgs,
        fullAccess: prepared.fullAccess,
        useWorktree: false,
        persona: opts.persona,
        role: "review",
        parentAgentId: displayParentId,
        launchedByAgentId: parentId,
        ...(useWorktreeOf ? { projectId: parent.projectId } : {}),
        personaContext: opts.context,
        initialPrompt: buildPersonaKickoffPrompt(parentId),
        launchContext: { prompt: opts.context },
      },
      { detachLaunch: true, ...(useWorktreeOf ? { useWorktreeOf } : {}) }
    );
    const fresh = await agentManager.getAgent(agent.id);
    publishUiEvent({
      type: "agent.upsert",
      agent: withStreamFlag(fresh ?? agent),
    });
    return {
      agentId: agent.id,
      name: agent.name,
      persona: opts.persona,
      ...(Buffer.byteLength(prepared.prompt, "utf8") > MAX_PERSONA_PROMPT_BYTES
        ? {
            warnings: [
              "Persona launch context exceeds 64KiB; the complete context will be delivered through a private file that the reviewer is instructed to read. No content is trimmed.",
            ],
          }
        : {}),
    };
  }

  async function launchOwnerReviews(
    parentId: string,
    opts: {
      context: string;
      agentType?: (typeof CLI_AGENT_TYPES)[number];
      model?: string;
      effort?: Effort | null;
      dryRun?: boolean;
      personas?: string[];
    }
  ): Promise<OwnerReviewResult> {
    const parent = await agentManager.getAgent(parentId);
    if (!parent) throw new Error("Parent agent not found.");
    const changes = await inspectReviewChanges(parent);
    const reviewedState = { head: changes.head, stateId: changes.stateId };
    const readCheckoutFile = (path: string) =>
      readAgentCheckoutFile(agentManager, parent, path);
    let ownersPath = OWNERS_PATH;
    let content = await readCheckoutFile(ownersPath);
    if (content === null) {
      ownersPath = LEGACY_OWNERS_PATH;
      content = await readCheckoutFile(ownersPath);
    }
    if (content === null)
      throw new Error(
        `No ${OWNERS_PATH} found in this workspace. Add ownership rules before launching owner reviews.`
      );
    const config = parseCodeowners(content, ownersPath);
    const resolvedPlan = resolveCodeowners(
      config,
      changes.files,
      changes.baseRef
    );
    let plan = resolvedPlan;
    let omittedOwners: OwnerReviewResult["omittedOwners"];
    if (opts.personas !== undefined) {
      if (!opts.personas.length)
        throw new Error("personas must contain at least one owner persona.");
      const requested = new Set(opts.personas);
      for (const slug of requested) {
        if (!resolvedPlan.owners.some((owner) => owner.persona === slug))
          throw new Error(
            `Persona "${slug}" is not in the resolved owner plan. Available owners: ${resolvedPlan.owners.map((owner) => owner.persona).join(", ") || "(none)"}.`
          );
      }
      omittedOwners = resolvedPlan.owners.filter(
        (owner) => !requested.has(owner.persona)
      );
      plan = {
        ...resolvedPlan,
        owners: resolvedPlan.owners.filter((owner) =>
          requested.has(owner.persona)
        ),
      };
    }
    const selection = omittedOwners === undefined ? {} : { omittedOwners };
    // Resolve the whole selection before launching any agent. Ownership is
    // local to this checkout, even though manual persona launches can fall back.
    const selectedPersonas = new Map<string, PersonaDefinition>();
    const validateOwners =
      opts.dryRun && opts.personas === undefined ? [] : plan.owners;
    for (const owner of validateOwners) {
      const persona =
        (await loadPersonaFromCheckout(owner.persona, readCheckoutFile)) ??
        getBuiltInPersona(owner.persona);
      if (!persona)
        throw new Error(
          `Owner persona "${owner.persona}" not found in this workspace or built-ins.`
        );
      if (!supportsPersonaType(persona, "review"))
        throw new Error(
          `Owner persona "${owner.persona}" is not available for review launches.`
        );
      if (!persona.body.trim())
        throw new Error(
          `Owner persona "${owner.persona}" has no instructions.`
        );
      selectedPersonas.set(owner.persona, persona);
    }
    const author = await agentManager.getAgent(parentId);
    if (!author) throw new Error("Parent agent not found.");
    const latest = await inspectReviewChanges(author);
    if (
      latest.baseRef !== changes.baseRef ||
      latest.head !== reviewedState.head ||
      latest.stateId !== reviewedState.stateId
    )
      throw new Error(
        "The checkout changed while planning owner reviews. Finish the checkout changes, then retry launch_owner_reviews."
      );
    if (opts.dryRun)
      return {
        ...plan,
        ...selection,
        reviewedState,
        launched: [],
        failures: [],
      };
    const result = await launchOwnerReviewPlan(
      plan,
      opts.context,
      (persona, context) => {
        const launchOpts = {
          persona,
          context: `Inspect the shared checkout without modifying it. Report findings to the launcher.\nCheckout recorded during review planning: HEAD ${reviewedState.head}, state ID ${reviewedState.stateId}.\n\n${context}`,
          agentType: opts.agentType,
          model: opts.model,
          effort: opts.effort,
        };
        return launchReviewer(
          author,
          launchOpts,
          () =>
            prepareReviewLaunch(
              author,
              launchOpts,
              author.cwd,
              false,
              () => selectedPersonas.get(persona)!
            ),
          author.id
        );
      }
    );
    return { ...result, ...selection, reviewedState };
  }

  async function inspectReviewChanges(agent: AgentRecord) {
    const baseBranch = remotePlacement(agent.cwd)
      ? null
      : agent.workspacePath
        ? (agent.workspaceBaseBranch ?? null)
        : (agent.baseBranch ??
          (agent.worktreePath && agent.worktreeBranch ? "main" : null));
    const reply = await agentManager.inspectCheckout(agent, {
      kind: "changes",
      baseBranch,
    });
    if (reply.kind !== "changes")
      throw new Error("Runner did not return checkout changes.");
    return reply;
  }

  async function listPersonas(agentCwd: string) {
    const {
      personas: loaded,
      warnings,
      refreshing,
    } = await discoverPersonas(agentCwd, "workspace");
    if (refreshing)
      warnings.push(
        "Default-branch persona catalog is refreshing in the background. This list contains currently available definitions; list again shortly for newly merged personas."
      );
    const personas = loaded.map(({ slug, name, description, type }) => ({
      type: type ?? "review",
      slug,
      name,
      description,
    }));
    return { personas, warnings };
  }

  return {
    preparePersonaLaunch,
    launchPersonaAgent,
    launchOwnerReviews,
    listPersonas,
  };
}

/** The first turn a persona agent receives: begin, and where to report. */
export function buildPersonaKickoffPrompt(parentAgentId: string): string {
  return [
    "Begin now. Your persona instructions and the launcher's briefing are already in your context. Inspect the relevant material according to that scope.",
    `When you are done, post your result to the agent that launched you: post with to: "${parentAgentId}". A reviewer posts one \`review\` block (summary, findings); any other persona posts what its instructions say.`,
    "Later replies in that thread arrive as new prompts; answer in the thread (post with replyTo).",
  ].join("\n");
}
