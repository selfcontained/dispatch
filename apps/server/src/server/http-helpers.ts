import type { FastifyReply } from "fastify";

import { AgentError } from "../agents/manager.js";

export function handleAgentError(reply: FastifyReply, error: unknown) {
  if (error instanceof AgentError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }

  const message = error instanceof Error ? error.message : "Unknown error.";
  return reply.code(500).send({ error: message });
}

export function getBearerToken(request: {
  headers: Record<string, unknown>;
}): string | null {
  const authHeader = request.headers.authorization;
  if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  return authHeader.slice(7);
}
