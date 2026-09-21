import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import * as z from "zod/v4";
import type {
  ChatUnreadSummary,
  StreamAnswerRequest,
  StreamPostRequest,
  StreamSubmitRequest,
} from "@dispatch/shared";
import { BLOCK_ATTACHMENTS_MAX, BLOCK_TEXT_MAX_CHARS } from "@dispatch/shared";

import { composeStreamFeed, decodeFeedCursor } from "../chat/feed.js";
import { StreamServiceError, type StreamService } from "../chat/service.js";
import { isBlockId } from "../chat/store.js";
import { attachTurns } from "../chat/turns.js";
import { chatUrlSchema } from "../chat/validation.js";

type StreamRouteDeps = {
  pool: Pool;
  streams: StreamService;
  /** Maps `AgentError` (and anything else) from the service to a response. */
  handleAgentError: (reply: FastifyReply, error: unknown) => FastifyReply;
};

/**
 * `POST /streams/:rootId/blocks` body. Shape only: the cross-field rule
 * (blank text needs an attachment) and attachment resolution live in the
 * service. The user path takes files by `fileId` only — the row came from
 * `POST /agents/:id/files` moments ago.
 */
const userAttachmentSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("file"), fileId: z.int().positive() }),
  z.strictObject({
    type: z.literal("link"),
    url: chatUrlSchema,
    title: z.string().max(200).optional(),
  }),
]);

const reviewBodySchema = z.object({
  verdict: z.enum(["approve", "request_changes", "comment"]),
  summary: z.string().min(1).max(4000),
  findings: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        severity: z.enum(["blocker", "major", "minor", "nit"]),
        title: z.string().min(1).max(300),
        body: z.string().min(1).max(BLOCK_TEXT_MAX_CHARS),
        path: z.string().max(1000).optional(),
        line: z.int().positive().optional(),
      })
    )
    .max(50),
});

const postBodySchema = z.object({
  id: z.uuid().optional(),
  to: z.string().min(1).optional(),
  /** A review left by hand (the Changes tab): the block is a `review`. */
  review: reviewBodySchema.optional(),
  text: z
    .string()
    .max(
      BLOCK_TEXT_MAX_CHARS,
      `text must be ${BLOCK_TEXT_MAX_CHARS} characters or fewer.`
    )
    .default(""),
  replyTo: z.uuid().optional(),
  finding: z.string().min(1).max(64).optional(),
  attachments: z
    .array(userAttachmentSchema)
    .max(BLOCK_ATTACHMENTS_MAX)
    .optional(),
  interrupt: z.boolean().optional(),
}) satisfies z.ZodType<StreamPostRequest, unknown>;

const answerBodySchema = z.object({
  id: z.uuid().optional(),
  value: z.string("value is required."),
  label: z.string("label must be a string.").optional(),
  attachments: z
    .array(userAttachmentSchema)
    .max(BLOCK_ATTACHMENTS_MAX)
    .optional(),
}) satisfies z.ZodType<StreamAnswerRequest, unknown>;

const submitBodySchema = z.object({
  id: z.uuid().optional(),
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
}) satisfies z.ZodType<StreamSubmitRequest, unknown>;

const stateBodySchema = z.object({
  state: z.record(z.string(), z.unknown()),
});

/** First zod issue as a 400 message, pointing at the offending attachment. */
function bodyIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  const where =
    issue?.path[0] === "attachments" ? `${issue.path.join(".")}: ` : "";
  return `${where}${issue?.message ?? "Invalid body."}`;
}

/**
 * HTTP surface over `StreamService`: body shape checks and status-code
 * mapping live here; the workflows live in the service. `:rootId` is the
 * stream's root agent.
 */
export async function registerStreamRoutes(
  app: FastifyInstance,
  deps: StreamRouteDeps
): Promise<void> {
  const { streams } = deps;
  const store = streams.store;

  async function agentExists(id: string): Promise<boolean> {
    const result = await deps.pool.query("SELECT 1 FROM agents WHERE id = $1", [
      id,
    ]);
    return result.rows.length > 0;
  }

  function sendError(reply: FastifyReply, error: unknown): FastifyReply {
    if (error instanceof StreamServiceError) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    return deps.handleAgentError(reply, error);
  }

  app.get("/api/v1/chat/unread", async (): Promise<ChatUnreadSummary> => {
    return store.unreadSummary();
  });

  app.get("/api/v1/streams/:rootId/blocks", async (request, reply) => {
    const rootId = (request.params as { rootId?: string }).rootId ?? "";
    const query = request.query as { cursor?: string; limit?: string };
    if (!(await agentExists(rootId))) {
      return reply.code(404).send({ error: "Agent not found." });
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
    return composeStreamFeed(store, rootId, { cursor, limit });
  });

  app.get(
    "/api/v1/streams/:rootId/blocks/:blockId/thread",
    async (request, reply) => {
      const params = request.params as { rootId?: string; blockId?: string };
      const rootId = params.rootId ?? "";
      const blockId = params.blockId ?? "";
      if (!isBlockId(blockId)) {
        return reply.code(400).send({ error: "blockId must be a UUID." });
      }
      const thread = await store.listThread(blockId);
      if (!thread || thread.root.streamId !== rootId) {
        return reply.code(404).send({ error: "Block not found." });
      }
      // A turn answered into the thread carries its turn like any feed row.
      await attachTurns(store.db, [thread.root, ...thread.replies]);
      return thread;
    }
  );

  app.post("/api/v1/streams/:rootId/blocks", async (request, reply) => {
    const rootId = (request.params as { rootId?: string }).rootId ?? "";
    const parsed = postBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: bodyIssueMessage(parsed.error) });
    }
    if (!(await agentExists(rootId))) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    try {
      return await streams.sendUserPost(rootId, {
        id: parsed.data.id,
        to: parsed.data.to ?? null,
        text: parsed.data.text,
        replyTo: parsed.data.replyTo ?? null,
        finding: parsed.data.finding ?? null,
        attachments: parsed.data.attachments ?? [],
        ...(parsed.data.review ? { review: parsed.data.review } : {}),
        ...(parsed.data.interrupt ? { interrupt: true } : {}),
        allowInert: true,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post(
    "/api/v1/streams/:rootId/blocks/:blockId/answer",
    async (request, reply) => {
      const params = request.params as { rootId?: string; blockId?: string };
      const parsed = answerBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: bodyIssueMessage(parsed.error) });
      }
      const { value, label, attachments, id } = parsed.data;
      try {
        return await streams.answerQuestion(
          params.rootId ?? "",
          params.blockId ?? "",
          {
            value,
            ...(id !== undefined ? { id } : {}),
            ...(label !== undefined ? { label } : {}),
            ...(attachments && attachments.length > 0 ? { attachments } : {}),
          }
        );
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  // Send a post the agent never took, again. The block is the one already
  // in the stream: its row goes back to pending and the same words are
  // queued once more.
  app.post(
    "/api/v1/streams/:rootId/blocks/:blockId/retry",
    async (request, reply) => {
      const params = request.params as { rootId?: string; blockId?: string };
      try {
        return await streams.retryDelivery(
          params.rootId ?? "",
          params.blockId ?? ""
        );
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.post(
    "/api/v1/streams/:rootId/blocks/:blockId/submit",
    async (request, reply) => {
      const params = request.params as { rootId?: string; blockId?: string };
      const parsed = submitBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: bodyIssueMessage(parsed.error) });
      }
      try {
        return await streams.submitForm(
          params.rootId ?? "",
          params.blockId ?? "",
          parsed.data
        );
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.patch(
    "/api/v1/streams/:rootId/blocks/:blockId/state",
    async (request, reply) => {
      const params = request.params as { rootId?: string; blockId?: string };
      const parsed = stateBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: bodyIssueMessage(parsed.error) });
      }
      try {
        const block = await streams.setState(
          params.rootId ?? "",
          params.blockId ?? "",
          parsed.data.state,
          { kind: "user" }
        );
        return { block };
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.post(
    "/api/v1/streams/:rootId/blocks/:blockId/reactions",
    async (request, reply) => {
      const params = request.params as { rootId?: string; blockId?: string };
      const body = request.body as { emoji?: unknown } | null;
      try {
        return await streams.addReaction(
          params.rootId ?? "",
          params.blockId ?? "",
          body?.emoji
        );
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.delete(
    "/api/v1/streams/:rootId/blocks/:blockId/reactions/:emoji",
    async (request, reply) => {
      const params = request.params as {
        rootId?: string;
        blockId?: string;
        emoji?: string;
      };
      try {
        return await streams.removeReaction(
          params.rootId ?? "",
          params.blockId ?? "",
          params.emoji
        );
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.post(
    "/api/v1/streams/:rootId/blocks/:blockId/read",
    async (request, reply) => {
      const { rootId = "", blockId = "" } = request.params as {
        rootId?: string;
        blockId?: string;
      };
      const body = request.body as { finding?: unknown } | null;
      const finding = body?.finding;
      if (finding != null && typeof finding !== "string") {
        return reply.code(400).send({ error: "finding must be a string." });
      }
      if (!isBlockId(blockId)) {
        return reply.code(400).send({ error: "blockId must be a UUID." });
      }
      if (!(await agentExists(rootId))) {
        return reply.code(404).send({ error: "Agent not found." });
      }
      const marked = await store.markThreadRead(rootId, blockId, finding);
      return { ids: marked.ids, readAt: marked.readAt };
    }
  );

  app.post("/api/v1/streams/:rootId/read", async (request, reply) => {
    const rootId = (request.params as { rootId?: string }).rootId ?? "";
    const body = request.body as { upTo?: unknown } | null;
    const upTo = body?.upTo;
    if (upTo != null && !isBlockId(upTo)) {
      return reply.code(400).send({ error: "upTo must be a block id (UUID)." });
    }
    if (!(await agentExists(rootId))) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    const marked = await store.markRead(rootId, upTo ?? undefined);
    const unreadCount = await store.countUnread(rootId);
    if (marked.updated > 0 && marked.readAt !== null) {
      streams.publishRead(rootId, {
        unreadCount,
        readAt: marked.readAt,
        upToAt: marked.upToAt,
      });
    }
    return { unreadCount };
  });
}
