import type { FastifyInstance, FastifyReply } from "fastify";

import type { AgentManager } from "../agents/manager.js";
import { StreamServiceError, type StreamService } from "../chat/service.js";
import { CLI_AGENT_TYPES } from "../agent-type-settings.js";
import { validateAgentModel } from "../shared/agent-models.js";
import { hasCodeowners } from "../personas/codeowners.js";
import { loadPersonasFromRoots } from "../personas/loader.js";
import {
  resolveRepoRoot,
  resolveWorktreeRoot,
} from "../shared/git/git-context.js";

type PersonaRouteDeps = {
  agentManager: AgentManager;
  /**
   * The request reaches the agent as a post in its stream: the agent
   * launches the persona itself, with its own briefing of the work.
   */
  streams: Pick<StreamService, "promptAgent">;
  handleAgentError: (reply: FastifyReply, error: unknown) => FastifyReply;
};

/**
 * What the agent is asked to do. The agent has the context a reviewer
 * needs (what changed, where to look, what to be careful about); a launch
 * made by the server with a generic note loses all of that.
 */
export function personaLaunchRequest(input: {
  personas: string[];
  /** Also route reviewers by .dispatch/codeowners.json and the changed files. */
  codeowners?: boolean;
  agentType: string;
  model?: string;
  includeDiff?: boolean;
  note?: string;
}): string {
  const modelArgs = input.model ? [`model: "${input.model}"`] : [];
  const lines = input.personas.map((persona) => {
    const args = [
      `persona: "${persona}"`,
      `type: "${input.agentType}"`,
      ...modelArgs,
      ...(input.includeDiff === false ? ["includeDiff: false"] : []),
    ];
    return `- launch_agent({ ${args.join(", ")}, prompt: <your briefing> })`;
  });
  if (input.codeowners) {
    // The owner tool names the runtime `agentType` where launch_agent says
    // `type`. Owner reviews always carry the change map; includeDiff has no say.
    const args = [`agentType: "${input.agentType}"`, ...modelArgs];
    lines.unshift(
      `- launch_owner_reviews({ ${args.join(", ")}, context: <your briefing> }) — the code owners for your changed files, selected from .dispatch/codeowners.json`
    );
  }
  const subject = input.codeowners
    ? input.personas.length === 0
      ? "the code owners"
      : input.personas.length === 1
        ? `the code owners and the ${input.personas[0]} persona`
        : "the code owners and these personas"
    : input.personas.length === 1
      ? `the ${input.personas[0]} persona`
      : "these personas";
  return [
    `Please launch ${subject} on your current work:`,
    ...lines,
    // A hand-picked persona may also be an owner; neither tool knows about
    // the other's launches, so the agent has to keep them from overlapping.
    ...(input.codeowners && input.personas.length > 0
      ? [
          "Run launch_owner_reviews first and read its `launched` list; skip the launch_agent line for any persona it already launched (a persona in `failures` is still yours to launch).",
        ]
      : []),
    "Write the briefing yourself: what you changed and why, the files that matter, what to scrutinize, and what is out of scope. Each reviewer posts one review back to you; answer every finding under it, and its reviewer resolves it.",
    ...(input.note?.trim() ? ["", `From the user: ${input.note.trim()}`] : []),
  ].join("\n");
}

const MAX_LAUNCH_NOTE_LENGTH = 2000;

const PERSONA_SLUG_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;

// Each selected persona becomes a child agent, so the request is bounded
// independently of the body limit; slugs are resolved against files on disk
// by the launcher, not here.
const MAX_LAUNCH_PERSONAS = 20;

const PERSONAS_REQUIRED_ERROR =
  "persona (string), personas (non-empty array of strings), or codeowners: true is required.";

async function resolveOptionalWorktreeRoot(
  cwd: string
): Promise<string | null> {
  try {
    return await resolveWorktreeRoot(cwd);
  } catch {
    return null;
  }
}

async function resolveOptionalRepoRoot(cwd: string): Promise<string | null> {
  try {
    return await resolveRepoRoot(cwd);
  } catch {
    return null;
  }
}

export async function registerPersonaRoutes(
  app: FastifyInstance,
  deps: PersonaRouteDeps
): Promise<void> {
  app.get("/api/v1/personas", async (request, reply) => {
    const query = request.query as { cwd?: unknown };
    if (typeof query.cwd !== "string") {
      return reply
        .code(400)
        .send({ error: "cwd query parameter is required." });
    }
    try {
      const worktreeRoot = await resolveOptionalWorktreeRoot(query.cwd);
      const repoRoot = await resolveOptionalRepoRoot(query.cwd);
      const personas = await loadPersonasFromRoots({ worktreeRoot, repoRoot });
      // Owner reviews read the map from the checkout being reviewed, so only
      // the worktree decides whether the option is offered.
      const codeowners = worktreeRoot
        ? await hasCodeowners(worktreeRoot)
        : false;
      return { personas, codeowners };
    } catch {
      return { personas: [], codeowners: false };
    }
  });

  app.post("/api/v1/agents/:id/launch-persona", async (request, reply) => {
    const params = request.params as { id?: string };
    const body = request.body as {
      persona?: unknown;
      personas?: unknown;
      codeowners?: unknown;
      agentType?: unknown;
      includeDiff?: unknown;
      model?: unknown;
      note?: unknown;
    } | null;
    const agentId = params.id ?? "";

    if (!body) {
      return reply.code(400).send({ error: PERSONAS_REQUIRED_ERROR });
    }
    if (body.personas !== undefined && !Array.isArray(body.personas)) {
      return reply.code(400).send({ error: PERSONAS_REQUIRED_ERROR });
    }
    if (body.codeowners !== undefined && typeof body.codeowners !== "boolean") {
      return reply
        .code(400)
        .send({ error: "codeowners must be a boolean when provided." });
    }
    const codeowners = body.codeowners === true;

    // `persona` is the pre-multi-select field. Deprecated: it only covers a
    // browser tab still running an older bundle; remove after 0.33.
    const rawPersonas: unknown[] =
      body.personas ?? (body.persona !== undefined ? [body.persona] : []);
    if (
      (rawPersonas.length === 0 && !codeowners) ||
      rawPersonas.some(
        (entry) => typeof entry !== "string" || entry.trim().length === 0
      )
    ) {
      return reply.code(400).send({ error: PERSONAS_REQUIRED_ERROR });
    }
    const personas = Array.from(
      new Set((rawPersonas as string[]).map((entry) => entry.trim()))
    );
    if (personas.length > MAX_LAUNCH_PERSONAS) {
      return reply.code(400).send({
        error: `personas must contain at most ${MAX_LAUNCH_PERSONAS} unique slugs.`,
      });
    }
    if (personas.some((persona) => !PERSONA_SLUG_PATTERN.test(persona))) {
      return reply.code(400).send({
        error:
          "persona must be a slug containing only letters, digits, underscore, or hyphen.",
      });
    }
    if (
      typeof body.agentType !== "string" ||
      !CLI_AGENT_TYPES.includes(
        body.agentType as (typeof CLI_AGENT_TYPES)[number]
      )
    ) {
      return reply.code(400).send({
        error: `agentType must be one of: ${CLI_AGENT_TYPES.join(", ")}`,
      });
    }
    if (
      body.includeDiff !== undefined &&
      typeof body.includeDiff !== "boolean"
    ) {
      return reply
        .code(400)
        .send({ error: "includeDiff must be a boolean when provided." });
    }
    if (
      body.model !== undefined &&
      body.model !== null &&
      typeof body.model !== "string"
    ) {
      return reply
        .code(400)
        .send({ error: "model must be a string or null when provided." });
    }
    if (
      body.note !== undefined &&
      body.note !== null &&
      typeof body.note !== "string"
    ) {
      return reply
        .code(400)
        .send({ error: "note must be a string or null when provided." });
    }
    if (
      typeof body.note === "string" &&
      body.note.length > MAX_LAUNCH_NOTE_LENGTH
    ) {
      return reply.code(400).send({
        error: `note must be at most ${MAX_LAUNCH_NOTE_LENGTH} characters.`,
      });
    }
    // Validate the model against this runtime's catalog before launching.
    let model: string | undefined;
    try {
      model = validateAgentModel(
        body.agentType as (typeof CLI_AGENT_TYPES)[number],
        typeof body.model === "string" ? body.model : undefined
      );
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Invalid model.",
      });
    }

    try {
      const parent = await deps.agentManager.getAgent(agentId);
      if (!parent) return reply.code(404).send({ error: "Agent not found." });
      const text = personaLaunchRequest({
        personas,
        codeowners,
        agentType: body.agentType as string,
        ...(model !== undefined ? { model } : {}),
        ...(body.includeDiff !== undefined
          ? { includeDiff: body.includeDiff }
          : {}),
        ...(typeof body.note === "string" ? { note: body.note } : {}),
      });
      // Start the agent's turn with its own review instructions. The stream
      // shows the agent's response as a normal turn.
      const { held } = await deps.streams.promptAgent(agentId, {
        text,
        description: `Review requested: ${[
          ...(codeowners ? ["code owners"] : []),
          ...personas,
        ].join(", ")}`,
      });
      return { ok: true, held };
    } catch (error) {
      if (error instanceof StreamServiceError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      return deps.handleAgentError(reply, error);
    }
  });
}
