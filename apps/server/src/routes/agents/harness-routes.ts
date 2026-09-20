import type { FastifyInstance } from "fastify";
import {
  CHAT_MESSAGE_MAX_CHARS,
  type HarnessCommandsResponse,
  type HarnessConfigResponse,
  type HarnessConfigUpdateRequest,
  type HarnessEditTurnRequest,
  type HarnessPathsResponse,
  type HarnessQueueResponse,
} from "@dispatch/shared";

import { listHarnessPaths } from "../../agents/harness/paths.js";
import { loadQueued } from "../../chat/turns.js";
import type { AgentRouteDeps } from "./shared.js";

export async function registerAgentHarnessRoutes(
  app: FastifyInstance,
  deps: Pick<AgentRouteDeps, "pool" | "harness" | "chat" | "appLog">
): Promise<void> {
  const exists = async (id: string): Promise<boolean> => {
    const row = await deps.pool.query(
      "SELECT 1 FROM agents WHERE id = $1 AND deleted_at IS NULL",
      [id]
    );
    return row.rows.length > 0;
  };

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

  app.get("/api/v1/agents/:id/harness/processes", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await exists(id)))
      return reply.code(404).send({ error: "Agent not found." });
    return {
      processes: ((await deps.harness.listProcesses?.(id)) ?? []).map(
        (process) => ({ ...process, output: "" })
      ),
    };
  });

  app.get(
    "/api/v1/agents/:id/harness/processes/:processId",
    async (request, reply) => {
      const { id, processId } = request.params as {
        id: string;
        processId: string;
      };
      if (!(await exists(id)))
        return reply.code(404).send({ error: "Agent not found." });
      const process = (await deps.harness.listProcesses?.(id))?.find(
        (p) => p.id === processId
      );
      if (!process)
        return reply.code(404).send({ error: "Process not found." });
      return process;
    }
  );

  app.post(
    "/api/v1/agents/:id/harness/processes/:processId/stop",
    async (request, reply) => {
      const { id, processId } = request.params as {
        id: string;
        processId: string;
      };
      if (!(await exists(id)))
        return reply.code(404).send({ error: "Agent not found." });
      if (!(await deps.harness.stopProcess?.(id, processId)))
        return reply.code(404).send({ error: "Process is no longer running." });
      return reply.code(204).send();
    }
  );

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
      queued: await loadQueued(deps.pool, id, deps.harness.listQueued(id)),
    };
    return response;
  });

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

  /**
   * Replace the running turn with an edited prompt. Nothing happens to the
   * turn until this is called: opening the editor and cancelling it are the
   * client's business alone.
   *
   * The order is the point. Everything that can refuse does so before the
   * cancel, so a refusal leaves the turn running. Then, with the queue held
   * so no queued prompt can slip into the gap: cancel and wait for the turn
   * to settle (deleting rows under a live turn would leave the engine
   * writing into a group that no longer exists), take the old turn and its
   * message out of the feed, send the new text, and release the queue with
   * the new message first in line.
   */
  app.post("/api/v1/agents/:id/harness/turn/edit", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    if (!(await exists(id))) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    const body = (request.body ?? {}) as Partial<HarnessEditTurnRequest>;
    const chatMessageId =
      typeof body.chatMessageId === "string" ? body.chatMessageId : "";
    const text = typeof body.text === "string" ? body.text : "";
    if (!chatMessageId) {
      return reply.code(400).send({ error: "chatMessageId is required." });
    }
    if (!text.trim()) {
      return reply.code(400).send({ error: "text is required." });
    }
    if (text.length > CHAT_MESSAGE_MAX_CHARS) {
      return reply.code(400).send({
        error: `text must be ${CHAT_MESSAGE_MAX_CHARS} characters or fewer.`,
      });
    }
    if (deps.harness.runningPromptId(id) !== chatMessageId) {
      return reply
        .code(409)
        .send({ error: "That turn is no longer running.", code: "TURN_ENDED" });
    }
    const hold = deps.harness.holdQueue(id);
    let firstId: string | undefined;
    try {
      await deps.harness.interruptAndWait(id);
      const recalled = await deps.chat.recallTurn(id, chatMessageId);
      if (!recalled) {
        return reply.code(409).send({
          error: "That turn is no longer running.",
          code: "TURN_ENDED",
        });
      }
      const sent = await deps.chat.sendUserMessage(id, text, [], {
        allowInert: true,
      });
      firstId = sent.message.id;
      return sent;
    } catch (error) {
      deps.appLog.warn({ err: error, agentId: id }, "harness turn edit failed");
      return reply.code(502).send({
        error:
          error instanceof Error
            ? error.message
            : "Could not replace the turn.",
      });
    } finally {
      hold.release(firstId);
    }
  });

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
