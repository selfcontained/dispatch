import type { FastifyInstance } from "fastify";
import type {
  HarnessConfigResponse,
  HarnessConfigUpdateRequest,
  HarnessSkillsResponse,
  HarnessSubagentResponse,
  HarnessTurnsResponse,
  HarnessUsageResponse,
} from "@dispatch/shared";

import {
  findSessionLog,
  readSessionLog,
} from "../../agents/dsh/session-log.js";
import { listDshSkills } from "../../agents/dsh/skills.js";
import { shapeSubagent } from "../../agents/dsh/subagents.js";
import { loadQueued, loadTurns } from "../../agents/dsh/turns.js";
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

  // What the provider keys have been used for; not per agent, the keys are
  // the service's. Cached a minute upstream.
  app.get("/api/v1/harness/usage", async () => {
    const response: HarnessUsageResponse = await deps.harness.usage();
    return response;
  });

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
    if (!(await exists(id))) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    const response: HarnessTurnsResponse = {
      turns: await loadTurns(deps.pool, id, limit),
      queued: await loadQueued(deps.pool, deps.harness.listQueued(id)),
    };
    return response;
  });

  // The queue: a prompt that has not started can jump the line or leave it.
  app.post(
    "/api/v1/agents/:id/harness/queue/:queuedId/send-now",
    async (request, reply) => {
      const { id = "", queuedId = "" } = request.params as {
        id?: string;
        queuedId?: string;
      };
      if (!(await exists(id))) {
        return reply.code(404).send({ error: "Agent not found." });
      }
      if (!(await deps.harness.sendQueuedNow(id, queuedId))) {
        return reply
          .code(404)
          .send({ error: "That message is no longer queued." });
      }
      return reply.code(204).send();
    }
  );

  app.delete(
    "/api/v1/agents/:id/harness/queue/:queuedId",
    async (request, reply) => {
      const { id = "", queuedId = "" } = request.params as {
        id?: string;
        queuedId?: string;
      };
      if (!(await exists(id))) {
        return reply.code(404).send({ error: "Agent not found." });
      }
      if (!deps.harness.removeQueued(id, queuedId)) {
        return reply
          .code(404)
          .send({ error: "That message is no longer queued." });
      }
      return reply.code(204).send();
    }
  );

  // A subagent the agent spawned: its own dsh session, read from the log.
  app.get(
    "/api/v1/agents/:id/harness/subagents/:sessionId",
    async (request, reply) => {
      const { id = "", sessionId = "" } = request.params as {
        id?: string;
        sessionId?: string;
      };
      const row = await deps.pool.query<{ cli_session_id: string | null }>(
        "SELECT cli_session_id FROM agents WHERE id = $1 AND deleted_at IS NULL",
        [id]
      );
      const agent = row.rows[0];
      if (!agent) return reply.code(404).send({ error: "Agent not found." });
      const file = await findSessionLog(deps.dshHome, sessionId);
      if (!file) {
        return reply.code(404).send({ error: "Subagent log not found." });
      }
      const log = await readSessionLog(file);
      // Only this agent's own children: the child names its parent session.
      if (
        !log.header?.parentSession ||
        log.header.parentSession !== agent.cli_session_id
      ) {
        return reply
          .code(404)
          .send({ error: "That session is not a subagent of this agent." });
      }
      const response: HarnessSubagentResponse = {
        subagent: shapeSubagent(sessionId.toLowerCase(), log),
      };
      return response;
    }
  );

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
