import type { FastifyInstance } from "fastify";

import { StreamServiceError } from "../../chat/service.js";
import { getQuickPhrase } from "../../db/quick-phrases.js";
import { substituteArgs } from "../../templates/arg-parser.js";
import type { AgentRouteDeps } from "./shared.js";

const TEXT_MAX = 10_000;
const ARG_VALUE_MAX = 2_000;

/**
 * Prompts the user fires from a UI control rather than typing into the
 * composer: a quick phrase. It becomes a user post in the stream, delivered
 * as the agent's next turn, so the agent's reply threads onto it exactly as
 * for a typed message.
 */
export async function registerAgentPromptRoutes(
  app: FastifyInstance,
  deps: AgentRouteDeps
): Promise<void> {
  // A quick phrase, rendered with its args. `submit: false` only renders:
  // the client puts the text in the composer for the user to edit.
  app.post("/api/v1/agents/:id/prompts/phrase", async (request, reply) => {
    const params = request.params as { id?: string };
    const body = request.body as {
      phraseId?: unknown;
      args?: unknown;
      submit?: unknown;
    } | null;
    const agentId = params.id ?? "";
    const phraseId = typeof body?.phraseId === "string" ? body.phraseId : "";
    const submit = body?.submit !== false;

    if (!phraseId) {
      return reply.code(400).send({ error: "phraseId is required." });
    }
    const phrase = await getQuickPhrase(deps.pool, phraseId);
    if (!phrase) {
      return reply.code(404).send({ error: "Phrase not found." });
    }

    const rawArgs =
      body?.args && typeof body.args === "object" && !Array.isArray(body.args)
        ? (body.args as Record<string, unknown>)
        : {};
    const args: Record<string, string> = {};
    for (const [key, val] of Object.entries(rawArgs)) {
      if (typeof val !== "string") {
        return reply
          .code(400)
          .send({ error: `arg "${key}" must be a string.` });
      }
      if (val.length > ARG_VALUE_MAX) {
        return reply.code(400).send({
          error: `arg "${key}" must be ${ARG_VALUE_MAX} characters or fewer.`,
        });
      }
      args[key] = val;
    }

    let text: string;
    try {
      text = substituteArgs(phrase.text, args);
    } catch (error) {
      return reply.code(400).send({
        error:
          error instanceof Error
            ? error.message
            : "Failed to substitute variables.",
      });
    }
    if (text.length > TEXT_MAX) {
      return reply.code(400).send({
        error: `Rendered phrase must be ${TEXT_MAX} characters or fewer.`,
      });
    }

    if (!submit) {
      const agent = await deps.agentManager.getAgent(agentId);
      if (!agent) return reply.code(404).send({ error: "Agent not found." });
      return { text };
    }
    try {
      await deps.chat.sendUserPost(await deps.chat.streamOf(agentId), {
        text,
        allowInert: false,
      });
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof StreamServiceError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      return deps.handleAgentError(reply, error);
    }
  });
}
