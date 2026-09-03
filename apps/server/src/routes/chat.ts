import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import type { ChatAnswerResponse, ChatSendResponse } from "@dispatch/shared";
import { CHAT_MESSAGE_MAX_CHARS } from "@dispatch/shared";

import type { AgentManager } from "../agents/manager.js";
import { composeChatFeed } from "../chat/feed.js";
import { buildChatEnvelope } from "../chat/envelope.js";
import type { ChatService } from "../chat/service.js";
import type { InjectionCoordinator } from "../terminal/injection-coordinator.js";

export type SendChatPrompt = (
  agentId: string,
  prompt: string,
  opts: { swallowFailure: false; awaitDelivery?: boolean }
) => Promise<void>;

type ChatRouteDeps = {
  pool: Pool;
  chat: ChatService;
  agentManager: Pick<AgentManager, "getTerminalAccess">;
  injectionCoordinator: Pick<InjectionCoordinator, "holdState">;
  sendAgentPrompt: SendChatPrompt;
  handleAgentError: (reply: FastifyReply, error: unknown) => FastifyReply;
};

export async function registerChatRoutes(
  app: FastifyInstance,
  deps: ChatRouteDeps
): Promise<void> {
  const { chat } = deps;
  const store = chat.store;

  async function agentExists(id: string): Promise<boolean> {
    const result = await deps.pool.query("SELECT 1 FROM agents WHERE id = $1", [
      id,
    ]);
    return result.rows.length > 0;
  }

  /**
   * Same rule as terminal inject-text: 409 when the agent has no tmux
   * session to deliver into. Resolves to null when delivery is possible;
   * otherwise to a function that sends the right error. (Sending inside an
   * awaited helper would hand Fastify's thenable reply back through the
   * promise chain and double-send.)
   */
  async function requireDeliverable(
    id: string
  ): Promise<((reply: FastifyReply) => FastifyReply) | null> {
    try {
      const access = await deps.agentManager.getTerminalAccess(id);
      if (access.mode !== "tmux") {
        return (reply) => reply.code(409).send({ error: access.message });
      }
      return null;
    } catch (error) {
      return (reply) => deps.handleAgentError(reply, error);
    }
  }

  /**
   * Inject the envelope. Enqueue-and-return (like dispatch_send_message):
   * the quiet gate can hold a delivery longer than a request should wait,
   * and `held` tells the client that is what is happening. Delivery failure
   * here means the session vanished between the access check and the
   * enqueue — recorded as delivered: false.
   */
  async function deliver(
    agentId: string,
    messageId: string,
    text: string
  ): Promise<{ delivered: boolean; held: boolean }> {
    let delivered = true;
    try {
      await deps.sendAgentPrompt(agentId, buildChatEnvelope(messageId, text), {
        swallowFailure: false,
        awaitDelivery: false,
      });
    } catch {
      delivered = false;
    }
    return {
      delivered,
      held: deps.injectionCoordinator.holdState(agentId).held,
    };
  }

  app.get("/api/v1/agents/:id/chat", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const query = request.query as { before?: string; limit?: string };
    if (!(await agentExists(id))) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    if (query.before !== undefined && Number.isNaN(Date.parse(query.before))) {
      return reply
        .code(400)
        .send({ error: "before must be an ISO timestamp." });
    }
    const limit = query.limit === undefined ? undefined : Number(query.limit);
    if (limit !== undefined && !Number.isFinite(limit)) {
      return reply.code(400).send({ error: "limit must be a number." });
    }
    return composeChatFeed(deps.pool, id, { before: query.before, limit });
  });

  app.post("/api/v1/agents/:id/chat/messages", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const body = request.body as { text?: unknown } | null;
    const text = typeof body?.text === "string" ? body.text : "";
    if (!text.trim()) {
      return reply.code(400).send({ error: "text is required." });
    }
    if (text.length > CHAT_MESSAGE_MAX_CHARS) {
      return reply.code(400).send({
        error: `text must be ${CHAT_MESSAGE_MAX_CHARS} characters or fewer.`,
      });
    }
    const blocked = await requireDeliverable(id);
    if (blocked) return blocked(reply);

    const inserted = await store.insert({
      agentId: id,
      authorKind: "user",
      kind: "reply",
      text,
      delivered: false,
    });
    const { delivered, held } = await deliver(id, inserted.id, text);
    if (delivered) await store.setDelivered(inserted.id, true);
    const message = (await store.getById(inserted.id)) ?? inserted;
    chat.publishChanged(id);
    const response: ChatSendResponse = { message, delivered, held };
    return response;
  });

  app.post(
    "/api/v1/agents/:id/chat/messages/:messageId/answer",
    async (request, reply) => {
      const params = request.params as { id?: string; messageId?: string };
      const id = params.id ?? "";
      const messageId = params.messageId ?? "";
      const body = request.body as { value?: unknown; label?: unknown } | null;
      const value = typeof body?.value === "string" ? body.value : "";
      const label = typeof body?.label === "string" ? body.label : undefined;
      if (!value.trim()) {
        return reply.code(400).send({ error: "value is required." });
      }
      const question = await store.getById(messageId);
      if (
        !question ||
        question.agentId !== id ||
        question.authorKind !== "agent" ||
        question.kind !== "question"
      ) {
        return reply.code(404).send({ error: "Question not found." });
      }
      if (question.answer) {
        return reply.code(409).send({ error: "Question already answered." });
      }
      const blocked = await requireDeliverable(id);
      if (blocked) return blocked(reply);

      const text = label?.trim() ? label : value;
      const inserted = await store.insert({
        agentId: id,
        authorKind: "user",
        kind: "reply",
        text,
        replyTo: question.id,
        delivered: false,
      });
      const answered = await store.recordAnswer(question.id, {
        value,
        ...(label !== undefined ? { label } : {}),
        replyMessageId: inserted.id,
        answeredAt: new Date().toISOString(),
      });
      if (!answered) {
        // Lost a race with a concurrent answer: drop our reply row.
        await deps.pool.query(`DELETE FROM agent_chat_messages WHERE id = $1`, [
          inserted.id,
        ]);
        return reply.code(409).send({ error: "Question already answered." });
      }
      const { delivered } = await deliver(id, inserted.id, text);
      if (delivered) await store.setDelivered(inserted.id, true);
      const replyMessage = (await store.getById(inserted.id)) ?? inserted;
      chat.publishChanged(id);
      const response: ChatAnswerResponse = {
        question: answered,
        reply: replyMessage,
        delivered,
      };
      return response;
    }
  );

  app.post("/api/v1/agents/:id/chat/read", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const body = request.body as { upTo?: unknown } | null;
    const upTo = typeof body?.upTo === "string" ? body.upTo : undefined;
    if (!(await agentExists(id))) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    const updated = await store.markRead(id, upTo);
    if (updated > 0) chat.publishChanged(id);
    return { unreadCount: await store.countUnread(id) };
  });
}
