import type { FastifyInstance } from "fastify";
import type {
  HarnessConfigResponse,
  HarnessConfigUpdateRequest,
  HarnessSkillsResponse,
  HarnessTurnsResponse,
} from "@dispatch/shared";

import { listDshSkills } from "../../agents/dsh/skills.js";
import { loadTurns } from "../../agents/dsh/turns.js";
import type { AgentRouteDeps } from "./shared.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Turns for the Harness view: read-only, assembled from the stream rows. */
export async function registerAgentHarnessRoutes(
  app: FastifyInstance,
  deps: Pick<AgentRouteDeps, "pool" | "dshHome" | "harness">
): Promise<void> {
  const exists = async (id: string): Promise<boolean> => {
    const row = await deps.pool.query(
      "SELECT 1 FROM agents WHERE id = $1 AND deleted_at IS NULL",
      [id]
    );
    return row.rows.length > 0;
  };

  // Session config: the model and reasoning effort dsh serves, live.
  app.get("/api/v1/agents/:id/harness/config", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    if (!(await exists(id))) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    const options = deps.harness.getConfigOptions(id);
    const response: HarnessConfigResponse = {
      running: options !== null,
      options: options ?? [],
    };
    return response;
  });

  app.put("/api/v1/agents/:id/harness/config", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const body = (request.body ?? {}) as Partial<HarnessConfigUpdateRequest>;
    if (
      typeof body.configId !== "string" ||
      !body.configId ||
      typeof body.value !== "string"
    ) {
      return reply
        .code(400)
        .send({ error: "configId and value are required." });
    }
    if (!(await exists(id))) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    if (deps.harness.getConfigOptions(id) === null) {
      return reply.code(409).send({ error: "The agent is not running." });
    }
    try {
      const options = await deps.harness.setConfigOption(
        id,
        body.configId,
        body.value
      );
      const response: HarnessConfigResponse = { running: true, options };
      return response;
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
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

  // Skills the agent can load, for the composer's slash menu.
  app.get("/api/v1/agents/:id/harness/skills", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const row = await deps.pool.query<{
      cwd: string;
      worktree_path: string | null;
    }>(
      "SELECT cwd, worktree_path FROM agents WHERE id = $1 AND deleted_at IS NULL",
      [id]
    );
    const agent = row.rows[0];
    if (!agent) return reply.code(404).send({ error: "Agent not found." });
    const response: HarnessSkillsResponse = {
      skills: await listDshSkills({
        cwd: agent.worktree_path ?? agent.cwd,
        dshHome: deps.dshHome,
      }),
    };
    return response;
  });
}
