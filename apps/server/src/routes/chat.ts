import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import type {
  ChatAnswerResponse,
  ChatSendResponse,
  ChatUnreadSummary,
} from "@dispatch/shared";
import { CHAT_MESSAGE_MAX_CHARS } from "@dispatch/shared";

import type { AgentManager } from "../agents/manager.js";
import { composeChatFeed, decodeFeedCursor } from "../chat/feed.js";
import { buildChatEnvelope } from "../chat/envelope.js";
import type { ChatService } from "../chat/service.js";
import { isChatMessageId } from "../chat/store.js";
import type { InjectionCoordinator } from "../terminal/injection-coordinator.js";
import { TmuxTerminal } from "../terminal/tmux-terminal.js";

/** The one terminal operation the chat routes need, for test substitution. */
export type ChatTerminal = Pick<TmuxTerminal, "sendCommand">;

type ChatRouteDeps = {
  pool: Pool;
  chat: ChatService;
  agentManager: Pick<AgentManager, "getTerminalAccess">;
  injectionCoordinator: Pick<InjectionCoordinator, "holdState" | "inject">;
  handleAgentError: (reply: FastifyReply, error: unknown) => FastifyReply;
  appLog: FastifyBaseLogger;
  createTerminal?: (sessionName: string) => ChatTerminal;
};

const ANSWER_LABEL_MAX = 200;

export async function registerChatRoutes(
  app: FastifyInstance,
  deps: ChatRouteDeps
): Promise<void> {
  const { chat } = deps;
  const store = chat.store;
  const createTerminal =
    deps.createTerminal ?? ((sessionName) => new TmuxTerminal(sessionName));

  async function agentExists(id: string): Promise<boolean> {
    const result = await deps.pool.query("SELECT 1 FROM agents WHERE id = $1", [
      id,
    ]);
    return result.rows.length > 0;
  }

  /**
   * Same rule as terminal inject-text: 409 when the agent has no tmux
   * session to deliver into. Resolves to the session name when delivery is
   * possible; otherwise to a function that sends the right error. (Sending
   * inside an awaited helper would hand Fastify's thenable reply back
   * through the promise chain and double-send.)
   */
  async function requireDeliverable(
    id: string
  ): Promise<
    | { sessionName: string; blocked?: undefined }
    | { blocked: (reply: FastifyReply) => FastifyReply }
  > {
    try {
      const access = await deps.agentManager.getTerminalAccess(id);
      if (access.mode !== "tmux") {
        return {
          blocked: (reply) => reply.code(409).send({ error: access.message }),
        };
      }
      return { sessionName: access.sessionName };
    } catch (error) {
      return { blocked: (reply) => deps.handleAgentError(reply, error) };
    }
  }

  /**
   * Enqueue the envelope and return at once. The quiet gate can hold a
   * delivery far longer than a request should wait, so the row stays
   * `delivered: null` (pending) until the injection actually settles; the
   * detached continuation then records true/false and publishes
   * `chat.changed`. `held` reports whether the gate is holding right now.
   */
  function deliverDetached(
    agentId: string,
    sessionName: string,
    messageId: string,
    text: string
  ): { held: boolean } {
    const terminal = createTerminal(sessionName);
    const envelope = buildChatEnvelope(messageId, text);
    const delivery = deps.injectionCoordinator.inject(agentId, () =>
      terminal.sendCommand(envelope)
    );
    void delivery
      .then(
        () => true,
        (error: unknown) => {
          deps.appLog.warn(
            { err: error, agentId, messageId },
            "chat: pane delivery failed — agent may have exited"
          );
          return false;
        }
      )
      .then(async (delivered) => {
        await store.setDelivered(messageId, delivered);
        chat.publishChanged(agentId);
      })
      .catch((error: unknown) => {
        deps.appLog.error(
          { err: error, agentId, messageId },
          "chat: failed to record delivery outcome"
        );
      });
    return { held: deps.injectionCoordinator.holdState(agentId).held };
  }

  app.get("/api/v1/chat/unread", async (): Promise<ChatUnreadSummary> => {
    return store.unreadSummary();
  });

  app.get("/api/v1/agents/:id/chat", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const query = request.query as {
      cursor?: string;
      before?: string;
      limit?: string;
    };
    if (!(await agentExists(id))) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    if (query.before !== undefined) {
      // Fail loudly: a client still paging by timestamp would otherwise
      // receive page one forever.
      return reply.code(400).send({
        error: "before is not supported; page with the cursor from nextCursor.",
      });
    }
    const cursor =
      query.cursor === undefined || query.cursor === ""
        ? null
        : decodeFeedCursor(query.cursor);
    if (query.cursor !== undefined && query.cursor !== "" && !cursor) {
      return reply.code(400).send({ error: "cursor is not valid." });
    }
    const limit = query.limit === undefined ? undefined : Number(query.limit);
    if (limit !== undefined && !Number.isFinite(limit)) {
      return reply.code(400).send({ error: "limit must be a number." });
    }
    return composeChatFeed(deps.pool, id, { cursor, limit });
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
    const access = await requireDeliverable(id);
    if (access.blocked) return access.blocked(reply);

    const message = await store.insert({
      agentId: id,
      authorKind: "user",
      kind: "reply",
      text,
      delivered: null,
    });
    const { held } = deliverDetached(id, access.sessionName, message.id, text);
    chat.publishChanged(id);
    const response: ChatSendResponse = { message, delivered: null, held };
    return response;
  });

  app.post(
    "/api/v1/agents/:id/chat/messages/:messageId/answer",
    async (request, reply) => {
      const params = request.params as { id?: string; messageId?: string };
      const id = params.id ?? "";
      const messageId = params.messageId ?? "";
      const body = request.body as { value?: unknown; label?: unknown } | null;
      if (!isChatMessageId(messageId)) {
        return reply.code(400).send({ error: "messageId must be a UUID." });
      }
      if (typeof body?.value !== "string" || !body.value.trim()) {
        return reply.code(400).send({ error: "value is required." });
      }
      if (body.label !== undefined && typeof body.label !== "string") {
        return reply.code(400).send({ error: "label must be a string." });
      }
      const value = body.value;
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

      // Resolve the option server-side: the stored question decides what a
      // value means. A client label only matters for a freeform answer.
      const options = question.question?.options ?? [];
      const option = options.find((o) => (o.value ?? o.label) === value);
      let label: string | undefined;
      if (option) {
        label = option.label;
      } else if (question.question?.allowFreeform) {
        const supplied =
          typeof body.label === "string" ? body.label.trim() : "";
        label = supplied ? supplied.slice(0, ANSWER_LABEL_MAX) : undefined;
      } else {
        return reply.code(400).send({
          error: "value does not match one of the question's options.",
        });
      }
      const text = option ? option.label : value;
      if (text.length > CHAT_MESSAGE_MAX_CHARS) {
        return reply.code(400).send({
          error: `value must be ${CHAT_MESSAGE_MAX_CHARS} characters or fewer.`,
        });
      }

      const access = await requireDeliverable(id);
      if (access.blocked) return access.blocked(reply);

      // Reply row and answer land together or not at all: a concurrent
      // answer makes recordAnswer match nothing, and the rollback takes the
      // orphan reply with it.
      const client = await deps.pool.connect();
      let replyMessage;
      let answered;
      try {
        await client.query("BEGIN");
        const tx = store.withClient(client);
        replyMessage = await tx.insert({
          agentId: id,
          authorKind: "user",
          kind: "reply",
          text,
          replyTo: question.id,
          delivered: null,
        });
        answered = await tx.recordAnswer(question.id, {
          value,
          ...(label !== undefined ? { label } : {}),
          replyMessageId: replyMessage.id,
          answeredAt: new Date().toISOString(),
        });
        if (!answered) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "Question already answered." });
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }

      deliverDetached(id, access.sessionName, replyMessage.id, text);
      chat.publishChanged(id);
      const response: ChatAnswerResponse = {
        question: answered,
        reply: replyMessage,
        delivered: null,
      };
      return response;
    }
  );

  app.post("/api/v1/agents/:id/chat/read", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const body = request.body as { upTo?: unknown } | null;
    const upTo = body?.upTo;
    if (upTo != null && !isChatMessageId(upTo)) {
      return reply
        .code(400)
        .send({ error: "upTo must be a message id (UUID)." });
    }
    if (!(await agentExists(id))) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    const updated = await store.markRead(id, upTo ?? undefined);
    if (updated > 0) chat.publishChanged(id);
    return { unreadCount: await store.countUnread(id) };
  });
}
