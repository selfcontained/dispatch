import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import * as z from "zod/v4";
import type {
  ChatAnswerRequest,
  ChatSendRequest,
  ChatUnreadSummary,
} from "@dispatch/shared";
import { CHAT_ATTACHMENTS_MAX, CHAT_MESSAGE_MAX_CHARS } from "@dispatch/shared";

import { composeChatFeed, decodeFeedCursor } from "../chat/feed.js";
import { ChatServiceError, type ChatService } from "../chat/service.js";
import { isChatMessageId } from "../chat/store.js";
import { chatUrlSchema } from "../chat/validation.js";

type ChatRouteDeps = {
  pool: Pool;
  chat: ChatService;
  /** Maps `AgentError` (and anything else) from the service to a response. */
  handleAgentError: (reply: FastifyReply, error: unknown) => FastifyReply;
};

/**
 * `POST /agents/:id/chat/messages` body. Shape only: the cross-field rule
 * (blank text needs an attachment) and attachment resolution live in the
 * service. The user path takes files by `mediaId` only — the row came from
 * `POST /agents/:id/media` moments ago, so there is no fileName to name.
 */
const userAttachmentSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("file"), mediaId: z.int().positive() }),
  z.strictObject({ type: z.literal("pin"), pinId: z.string().min(1) }),
  z.strictObject({
    type: z.literal("link"),
    url: chatUrlSchema,
    title: z.string().max(200).optional(),
  }),
]);

const sendBodySchema = z.object({
  text: z
    .string()
    .max(
      CHAT_MESSAGE_MAX_CHARS,
      `text must be ${CHAT_MESSAGE_MAX_CHARS} characters or fewer.`
    )
    .default(""),
  attachments: z
    .array(userAttachmentSchema)
    .max(CHAT_ATTACHMENTS_MAX)
    .optional(),
}) satisfies z.ZodType<ChatSendRequest, unknown>;

/**
 * `POST /agents/:id/chat/messages/:messageId/answer` body. Attachments take
 * the same shape and cap as a plain message; the service resolves them onto
 * the reply.
 */
const answerBodySchema = z.object({
  value: z.string("value is required."),
  label: z.string("label must be a string.").optional(),
  attachments: z
    .array(userAttachmentSchema)
    .max(CHAT_ATTACHMENTS_MAX)
    .optional(),
}) satisfies z.ZodType<ChatAnswerRequest, unknown>;

/** First zod issue as a 400 message, pointing at the offending attachment. */
function bodyIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  // Point at the offending attachment; top-level messages name their
  // field themselves.
  const where =
    issue?.path[0] === "attachments" ? `${issue.path.join(".")}: ` : "";
  return `${where}${issue?.message ?? "Invalid body."}`;
}

/**
 * HTTP surface over `ChatService`: body shape checks and status-code mapping
 * live here; the workflows (validation, option resolution, the answer
 * transaction, detached delivery, events) live in the service.
 */
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

  function sendError(reply: FastifyReply, error: unknown): FastifyReply {
    if (error instanceof ChatServiceError) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    return deps.handleAgentError(reply, error);
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
    const rawCursor = query.cursor || null;
    const cursor = rawCursor ? decodeFeedCursor(rawCursor) : null;
    if (rawCursor && !cursor) {
      return reply.code(400).send({ error: "cursor is not valid." });
    }
    const limit = query.limit === undefined ? undefined : Number(query.limit);
    if (limit !== undefined && !Number.isFinite(limit)) {
      return reply.code(400).send({ error: "limit must be a number." });
    }
    return composeChatFeed(store, id, { cursor, limit });
  });

  app.post("/api/v1/agents/:id/chat/messages", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const parsed = sendBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: bodyIssueMessage(parsed.error) });
    }
    try {
      return await chat.sendUserMessage(
        id,
        parsed.data.text,
        parsed.data.attachments ?? []
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post(
    "/api/v1/agents/:id/chat/messages/:messageId/answer",
    async (request, reply) => {
      const params = request.params as { id?: string; messageId?: string };
      const id = params.id ?? "";
      const messageId = params.messageId ?? "";
      const parsed = answerBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: bodyIssueMessage(parsed.error) });
      }
      const { value, label, attachments } = parsed.data;
      try {
        return await chat.answerQuestion(id, messageId, {
          value,
          ...(label !== undefined ? { label } : {}),
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        });
      } catch (error) {
        return sendError(reply, error);
      }
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
