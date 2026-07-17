import type { FastifyInstance, FastifyReply } from "fastify";

import type { AgentManager } from "../agents/manager.js";
import { CLI_AGENT_TYPES } from "../agent-type-settings.js";
import { loadPersonasFromRoots } from "../personas/loader.js";
import {
  resolveRepoRoot,
  resolveWorktreeRoot,
} from "../shared/git/git-context.js";

type PersonaRouteDeps = {
  agentManager: AgentManager;
  sendAgentPrompt: (agentId: string, prompt: string) => Promise<void>;
  handleAgentError: (reply: FastifyReply, error: unknown) => FastifyReply;
};

const PERSONA_SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

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

  app.post("/api/v1/agents/:id/launch-review", async (request, reply) => {
    const params = request.params as { id?: string };
    const body = request.body as {
      persona?: unknown;
      agentType?: unknown;
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
        `Use agentType: "${body.agentType}" and includeDiff: ${includeDiff ? "true" : "false"}.`,
        "Treat this as an author-requested review for the current worktree/branch.",
        "After launch, do not poll, sleep, call list_agents, or schedule a wakeup. End the turn and wait for Dispatch to inject the structured REVIEW SUBMITTED prompt. Keep all review discussion in feedback-item threads with the dispatch_review_* tools. After fixing an item, ask the reviewer to verify it instead of resolving it yourself.",
        "Provide a detailed context briefing covering what you built, key files changed, and any areas that need extra attention.",
      ].join(" ");

      await deps.sendAgentPrompt(agentId, prompt);
      return { ok: true };
    } catch (error) {
      return deps.handleAgentError(reply, error);
    }
  });
}
