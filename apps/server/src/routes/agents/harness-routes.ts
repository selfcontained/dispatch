import type { FastifyInstance } from "fastify";
import type { HarnessTurnsResponse } from "@dispatch/shared";

import { loadTurns } from "../../agents/dsh/turns.js";
import type { AgentRouteDeps } from "./shared.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Turns for the Harness view: read-only, assembled from the stream rows. */
export async function registerAgentHarnessRoutes(
  app: FastifyInstance,
  deps: Pick<AgentRouteDeps, "pool">
): Promise<void> {
  app.get("/api/v1/agents/:id/harness/turns", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const raw = (request.query as { limit?: string }).limit;
    let limit = DEFAULT_LIMIT;
    if (raw !== undefined) {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        return reply.code(400).send({ error: "limit must be a number." });
      }
      limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(parsed)));
    }
    const exists = await deps.pool.query(
      "SELECT 1 FROM agents WHERE id = $1 AND deleted_at IS NULL",
      [id]
    );
    if (exists.rows.length === 0) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    const response: HarnessTurnsResponse = {
      turns: await loadTurns(deps.pool, id, limit),
    };
    return response;
  });
}
