import type { FastifyInstance, FastifyReply } from "fastify";

import type { AgentManager, AgentRecord } from "../agents/manager.js";
import {
  CLI_AGENT_TYPES,
  getEnabledAgentTypes,
} from "../agent-type-settings.js";
import { loadPersonas } from "../personas/loader.js";
import {
  resolveRepoRoot,
  resolveWorktreeRoot,
} from "../shared/git/git-context.js";
import { resolveHeadSha } from "../shared/git/worktree.js";
import type { Pool } from "pg";

type PersonaReviewRouteDeps = {
  pool: Pool;
  agentManager: AgentManager;
  mcpLaunchPersona: (
    agentId: string,
    opts: {
      persona: string;
      context: string;
      agentType?: (typeof CLI_AGENT_TYPES)[number];
      allowRecheck?: boolean;
      includeDiff?: boolean;
    }
  ) => Promise<{ agentId: string; persona: string; parentAgentId: string }>;
  mcpCancelRecheck: (
    agentId: string,
    input: { personaAgentId: string; reason?: string }
  ) => Promise<void>;
  sendAgentPrompt: (agentId: string, prompt: string) => Promise<void>;
  publishUiEvent: (event: unknown) => void;
  withStreamFlag: <T extends AgentRecord>(
    agent: T
  ) => T & { hasStream: boolean };
  handleAgentError: (reply: FastifyReply, error: unknown) => FastifyReply;
};

const PERSONA_SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

export async function registerPersonaReviewRoutes(
  app: FastifyInstance,
  deps: PersonaReviewRouteDeps
): Promise<void> {
  app.get("/api/v1/personas", async (request, reply) => {
    const query = request.query as { cwd?: unknown };
    if (typeof query.cwd !== "string") {
      return reply
        .code(400)
        .send({ error: "cwd query parameter is required." });
    }
    try {
      let personas = await loadPersonas(await resolveWorktreeRoot(query.cwd));
      if (personas.length === 0) {
        personas = await loadPersonas(await resolveRepoRoot(query.cwd));
      }
      return { personas };
    } catch {
      return { personas: [] };
    }
  });

  app.post("/api/v1/agents/:id/launch-review", async (request, reply) => {
    const params = request.params as { id?: string };
    const body = request.body as {
      persona?: unknown;
      agentType?: unknown;
      allowRecheck?: unknown;
      includeDiff?: unknown;
    } | null;
    const agentId = params.id ?? "";

    if (typeof body?.persona !== "string" || body.persona.trim().length === 0) {
      return reply
        .code(400)
        .send({ error: "persona is required and must be a non-empty string." });
    }
    if (!PERSONA_SLUG_PATTERN.test(body.persona)) {
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
    if (typeof body.allowRecheck !== "boolean") {
      return reply
        .code(400)
        .send({ error: "allowRecheck is required and must be a boolean." });
    }
    if (
      body.includeDiff !== undefined &&
      typeof body.includeDiff !== "boolean"
    ) {
      return reply
        .code(400)
        .send({ error: "includeDiff must be a boolean when provided." });
    }

    try {
      const access = await deps.agentManager.getTerminalAccess(agentId);
      if (access.mode !== "tmux") {
        return reply
          .code(409)
          .send({ error: "Agent does not have an active tmux session." });
      }

      const includeDiff = body.includeDiff !== false;
      const prompt = [
        `Use the dispatch_launch_persona MCP tool to launch the "${body.persona}" persona on your current work.`,
        `Use agentType: "${body.agentType}", allowRecheck: ${body.allowRecheck ? "true" : "false"}, and includeDiff: ${includeDiff ? "true" : "false"}.`,
        "Treat this as an author-requested review for the current worktree/branch.",
        "After launch, if recheck is enabled, do not emit a terminal dispatch_event yet — you will receive a terminal prompt here when the reviewer reports back, and again after round 2.",
        "Provide a detailed context briefing covering what you built, key files changed, and any areas that need extra attention.",
      ].join(" ");

      await deps.sendAgentPrompt(agentId, prompt);
      return { ok: true };
    } catch (error) {
      return deps.handleAgentError(reply, error);
    }
  });

  app.post("/api/v1/agents/:id/persona-reviews", async (request, reply) => {
    const params = request.params as { id?: string };
    const body = request.body as {
      persona?: unknown;
      agentType?: unknown;
      allowRecheck?: unknown;
      includeDiff?: unknown;
      context?: unknown;
    } | null;
    const agentId = params.id ?? "";

    if (typeof body?.persona !== "string" || body.persona.trim().length === 0) {
      return reply
        .code(400)
        .send({ error: "persona is required and must be a non-empty string." });
    }
    if (!PERSONA_SLUG_PATTERN.test(body.persona.trim())) {
      return reply.code(400).send({
        error:
          "persona must be a slug containing only letters, digits, underscore, or hyphen.",
      });
    }
    if (
      body.agentType !== undefined &&
      (typeof body.agentType !== "string" ||
        !CLI_AGENT_TYPES.includes(
          body.agentType as (typeof CLI_AGENT_TYPES)[number]
        ))
    ) {
      return reply.code(400).send({
        error: `agentType must be one of: ${CLI_AGENT_TYPES.join(", ")}`,
      });
    }
    if (
      body.allowRecheck !== undefined &&
      typeof body.allowRecheck !== "boolean"
    ) {
      return reply
        .code(400)
        .send({ error: "allowRecheck must be a boolean when provided." });
    }
    if (
      body.includeDiff !== undefined &&
      typeof body.includeDiff !== "boolean"
    ) {
      return reply
        .code(400)
        .send({ error: "includeDiff must be a boolean when provided." });
    }
    if (body.context !== undefined && typeof body.context !== "string") {
      return reply
        .code(400)
        .send({ error: "context must be a string when provided." });
    }

    try {
      const parent = await deps.agentManager.getAgent(agentId);
      if (!parent) return reply.code(404).send({ error: "Agent not found." });
      const requestedAgentType = body.agentType as
        | (typeof CLI_AGENT_TYPES)[number]
        | undefined;
      if (requestedAgentType) {
        const enabledAgentTypes = await getEnabledAgentTypes(deps.pool);
        if (!enabledAgentTypes.includes(requestedAgentType)) {
          return reply.code(400).send({
            error: `${requestedAgentType} agents are disabled in settings.`,
          });
        }
      }

      const context =
        body.context?.trim() ||
        [
          `Review the current work for agent "${parent.name}".`,
          "Inspect the current diff, changed files, and surrounding code.",
          "Focus on actionable bugs, regressions, and missing validation.",
        ].join(" ");

      const result = await deps.mcpLaunchPersona(agentId, {
        persona: body.persona.trim(),
        context,
        agentType: requestedAgentType,
        allowRecheck: body.allowRecheck === true,
        includeDiff: body.includeDiff !== false,
      });
      const agent = await deps.agentManager.getAgent(result.agentId);
      return {
        agent: agent ? deps.withStreamFlag(agent) : null,
        agentId: result.agentId,
      };
    } catch (error) {
      return deps.handleAgentError(reply, error);
    }
  });

  app.post(
    "/api/v1/agents/:id/persona-reviews/:personaAgentId/resolution",
    async (request, reply) => {
      const params = request.params as {
        id?: string;
        personaAgentId?: string;
      };
      const body = request.body as { summary?: unknown } | null;
      const agentId = params.id ?? "";
      const personaAgentId = params.personaAgentId ?? "";

      if (
        typeof body?.summary !== "string" ||
        body.summary.trim().length === 0
      ) {
        return reply.code(400).send({
          error: "summary is required and must be a non-empty string.",
        });
      }

      try {
        const parent = await deps.agentManager.getAgent(agentId);
        if (!parent) return reply.code(404).send({ error: "Agent not found." });
        const resolutionCommit = await resolveHeadSha(parent.cwd);
        const result = await deps.agentManager.submitReviewResolution({
          parentAgentId: agentId,
          personaAgentId,
          summary: body.summary,
          resolutionCommit,
        });
        const [child, parentAgent] = await Promise.all([
          deps.agentManager.getAgent(personaAgentId),
          deps.agentManager.getAgent(agentId),
        ]);
        if (child) {
          deps.publishUiEvent({
            type: "agent.upsert",
            agent: deps.withStreamFlag(child),
          });
        }
        if (parentAgent) {
          deps.publishUiEvent({
            type: "agent.upsert",
            agent: deps.withStreamFlag(parentAgent),
          });
        }
        return { review: result.review, resolution: result.resolution };
      } catch (error) {
        return deps.handleAgentError(reply, error);
      }
    }
  );

  app.post(
    "/api/v1/agents/:id/persona-reviews/:personaAgentId/cancel-recheck",
    async (request, reply) => {
      const params = request.params as {
        id?: string;
        personaAgentId?: string;
      };
      const body = request.body as { reason?: unknown } | null;
      const agentId = params.id ?? "";
      const personaAgentId = params.personaAgentId ?? "";

      if (body?.reason !== undefined && typeof body.reason !== "string") {
        return reply
          .code(400)
          .send({ error: "reason must be a string when provided." });
      }

      try {
        await deps.mcpCancelRecheck(agentId, {
          personaAgentId,
          reason:
            typeof body?.reason === "string" && body.reason.trim().length > 0
              ? body.reason.trim()
              : undefined,
        });
        return reply.code(204).send();
      } catch (error) {
        return deps.handleAgentError(reply, error);
      }
    }
  );
}
