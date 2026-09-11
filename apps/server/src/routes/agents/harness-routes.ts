import type { FastifyInstance } from "fastify";
import type {
  HarnessCommandsResponse,
  HarnessConfigResponse,
  HarnessConfigUpdateRequest,
  HarnessPathsResponse,
  HarnessQueueResponse,
} from "@dispatch/shared";

import { listHarnessPaths } from "../../agents/harness/paths.js";
import { loadQueued } from "../../chat/turns.js";
import { loadAgentUsage, monthStartUtc } from "../../agents/harness/usage.js";
import type { AgentRouteDeps } from "./shared.js";

/** A Dispatch Harness agent's routes: the queue, session config, commands, usage, paths. */
export async function registerAgentHarnessRoutes(
  app: FastifyInstance,
  deps: Pick<AgentRouteDeps, "pool" | "harness">
): Promise<void> {
  const exists = async (id: string): Promise<boolean> => {
    const row = await deps.pool.query(
      "SELECT 1 FROM agents WHERE id = $1 AND deleted_at IS NULL",
      [id]
    );
    return row.rows.length > 0;
  };

  // Session config: the model and reasoning effort the engine serves, live.
  app.get("/api/v1/agents/:id/harness/config", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    if (!(await exists(id))) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    const options = deps.harness.getConfigOptions(id);
    const sessionStartedAt = deps.harness.getSessionStartedAt(id);
    const response: HarnessConfigResponse = {
      running: options !== null,
      ...(sessionStartedAt ? { sessionStartedAt } : {}),
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
      const sessionStartedAt = deps.harness.getSessionStartedAt(id);
      const response: HarnessConfigResponse = {
        running: true,
        ...(sessionStartedAt ? { sessionStartedAt } : {}),
        options,
      };
      return response;
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  // What waits behind the running turn. In-memory supervisor state, not a
  // feed row: the composer reads it from here rather than from the turns.
  app.get("/api/v1/agents/:id/harness/queue", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    if (!(await exists(id))) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    const response: HarnessQueueResponse = {
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

  // Stop: cancel the running turn. Queued prompts stay queued and run next.
  app.post("/api/v1/agents/:id/harness/interrupt", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    if (!(await exists(id))) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    if (!(await deps.harness.interrupt(id))) {
      return reply.code(409).send({ error: "No turn is running." });
    }
    return reply.code(204).send();
  });

  // The slash commands the engine advertises, for the composer's "/" menu.
  app.get("/api/v1/agents/:id/harness/commands", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    if (!(await exists(id))) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    const response: HarnessCommandsResponse = {
      commands: deps.harness.getCommands(id) ?? [],
    };
    return response;
  });

  // This agent's tokens and cost this month, for the usage chip.
  app.get("/api/v1/agents/:id/harness/usage", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    if (!(await exists(id))) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    return {
      agent: await loadAgentUsage(deps.pool, id),
      monthStart: monthStartUtc().toISOString(),
    };
  });

  /** The tree the agent works in (its worktree, else its cwd); null when no such agent. */
  const agentWorkingDir = async (id: string): Promise<string | null> => {
    const row = await deps.pool.query<{
      cwd: string;
      worktree_path: string | null;
    }>(
      "SELECT cwd, worktree_path FROM agents WHERE id = $1 AND deleted_at IS NULL",
      [id]
    );
    const agent = row.rows[0];
    return agent ? (agent.worktree_path ?? agent.cwd) : null;
  };

  // Paths under the working tree (or "~/…", or absolute), for the
  // composer's "@" picker: what was typed after the "@" is the query.
  app.get("/api/v1/agents/:id/harness/paths", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const q = (request.query as { q?: unknown }).q;
    const query = typeof q === "string" ? q : "";
    const cwd = await agentWorkingDir(id);
    if (cwd === null) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    const response: HarnessPathsResponse = {
      paths: await listHarnessPaths(query, { cwd }),
    };
    return response;
  });
}
