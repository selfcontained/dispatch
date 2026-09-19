import type { FastifyInstance, FastifyReply } from "fastify";

import type { AgentManager } from "../agents/manager.js";
import { CLI_AGENT_TYPES } from "../agent-type-settings.js";
import { validateAgentModel } from "../shared/agent-models.js";
import { loadPersonasFromRoots } from "../personas/loader.js";
import {
  resolveRepoRoot,
  resolveWorktreeRoot,
} from "../shared/git/git-context.js";

type PersonaRouteDeps = {
  agentManager: AgentManager;
  /** Launch a child running as a persona; see mcp-persona-handlers. */
  launchPersonaAgent: (
    parentId: string,
    opts: {
      persona: string;
      context: string;
      agentType?: (typeof CLI_AGENT_TYPES)[number];
      includeDiff?: boolean;
      model?: string;
    }
  ) => Promise<{ agentId: string; name: string; persona: string }>;
  handleAgentError: (reply: FastifyReply, error: unknown) => FastifyReply;
};

const MAX_LAUNCH_NOTE_LENGTH = 2000;

const PERSONA_SLUG_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;

// Each selected persona becomes a child agent, so the request is bounded
// independently of the body limit; slugs are resolved against files on disk
// by the launcher, not here.
const MAX_LAUNCH_PERSONAS = 20;

const PERSONAS_REQUIRED_ERROR =
  "persona (string) or personas (non-empty array of strings) is required.";

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
      return { personas };
    } catch {
      return { personas: [] };
    }
  });

  app.post("/api/v1/agents/:id/launch-persona", async (request, reply) => {
    const params = request.params as { id?: string };
    const body = request.body as {
      persona?: unknown;
      personas?: unknown;
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

    // `persona` is the pre-multi-select field. Deprecated: it only covers a
    // browser tab still running an older bundle; remove after 0.33.
    const rawPersonas: unknown[] = body.personas ?? [body.persona];
    if (
      rawPersonas.length === 0 ||
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
      const context =
        typeof body.note === "string" && body.note.trim().length > 0
          ? body.note.trim()
          : "Review the agent's current work in this worktree.";
      const launched = [];
      for (const persona of personas) {
        launched.push(
          await deps.launchPersonaAgent(agentId, {
            persona,
            context,
            agentType: body.agentType as (typeof CLI_AGENT_TYPES)[number],
            ...(body.includeDiff !== undefined
              ? { includeDiff: body.includeDiff }
              : {}),
            ...(model !== undefined ? { model } : {}),
          })
        );
      }
      return { ok: true, launched };
    } catch (error) {
      return deps.handleAgentError(reply, error);
    }
  });
}
