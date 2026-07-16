import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";

import type { AgentManager } from "../agents/manager.js";
import type { UiEvent } from "../server/ui-events.js";
import * as reviewQueries from "../agents/reviews.js";
import { getAgentFileDiff } from "../shared/git/agent-diff.js";
import { extractHunkAroundLines } from "../shared/lib/extract-hunk.js";
import {
  buildReviewItemStatePrompt,
  buildReviewSubmittedPrompt,
  buildReviewThreadUpdatePrompt,
} from "../reviews/injection-prompts.js";

type ReviewRouteDeps = {
  pool: Pool;
  agentManager: AgentManager;
  publishUiEvent: (event: UiEvent) => void;
  sendAgentPrompt: (agentId: string, prompt: string) => Promise<void>;
  handleAgentError: (reply: FastifyReply, error: unknown) => FastifyReply;
};

export async function registerReviewRoutes(
  app: FastifyInstance,
  deps: ReviewRouteDeps
): Promise<void> {
  app.post("/api/v1/agents/:id/reviews", async (request, reply) => {
    const params = request.params as { id?: string };
    const agentId = params.id ?? "";

    const body = request.body as {
      summary?: unknown;
      items?: unknown;
    } | null;

    if (!Array.isArray(body?.items) || body.items.length === 0) {
      return reply
        .code(400)
        .send({ error: "items is required and must be a non-empty array." });
    }

    if (body.items.length > 100) {
      return reply
        .code(400)
        .send({ error: "items array exceeds 100 item limit." });
    }

    if (body.summary !== undefined && body.summary !== null) {
      if (typeof body.summary !== "string") {
        return reply
          .code(400)
          .send({ error: "summary must be a string when provided." });
      }
      if (body.summary.length > 10_000) {
        return reply
          .code(400)
          .send({ error: "summary exceeds 10,000 character limit." });
      }
    }

    const validatedItems: reviewQueries.CreateReviewInput["items"] = [];
    for (let i = 0; i < body.items.length; i++) {
      const raw = body.items[i] as {
        filePath?: unknown;
        startLine?: unknown;
        endLine?: unknown;
        comment?: unknown;
      } | null;

      if (typeof raw?.comment !== "string" || !raw.comment.trim()) {
        return reply
          .code(400)
          .send({ error: `items[${i}].comment is required.` });
      }
      if (raw.comment.length > 10_000) {
        return reply.code(400).send({
          error: `items[${i}].comment exceeds 10,000 character limit.`,
        });
      }

      const item: reviewQueries.CreateReviewInput["items"][number] = {
        comment: raw.comment.trim(),
      };

      if (raw.filePath !== undefined && raw.filePath !== null) {
        if (typeof raw.filePath !== "string" || !raw.filePath.trim()) {
          return reply.code(400).send({
            error: `items[${i}].filePath must be a non-empty string.`,
          });
        }
        if (raw.filePath.includes("..")) {
          return reply
            .code(400)
            .send({ error: `items[${i}].filePath contains invalid path.` });
        }
        item.filePath = raw.filePath;

        if (raw.startLine !== undefined && raw.startLine !== null) {
          if (
            typeof raw.startLine !== "number" ||
            !Number.isInteger(raw.startLine) ||
            raw.startLine < 1
          ) {
            return reply.code(400).send({
              error: `items[${i}].startLine must be a positive integer.`,
            });
          }
          item.startLine = raw.startLine;

          if (raw.endLine !== undefined && raw.endLine !== null) {
            if (
              typeof raw.endLine !== "number" ||
              !Number.isInteger(raw.endLine) ||
              raw.endLine < raw.startLine
            ) {
              return reply.code(400).send({
                error: `items[${i}].endLine must be >= startLine.`,
              });
            }
            if (raw.endLine - raw.startLine > 500) {
              return reply
                .code(400)
                .send({ error: `items[${i}] line range too large.` });
            }
            item.endLine = raw.endLine;
          } else {
            item.endLine = raw.startLine;
          }
        }
      }

      validatedItems.push(item);
    }

    try {
      const agent = await deps.agentManager.getAgent(agentId);
      if (!agent) return reply.code(404).send({ error: "Agent not found." });

      const gitContextWorktreePath = agent.gitContext?.isWorktree
        ? agent.gitContext.worktreePath
        : null;
      const worktreePath =
        agent.worktreePath ?? gitContextWorktreePath ?? agent.cwd ?? null;
      const baseRef =
        agent.baseBranch ??
        (agent.worktreePath || gitContextWorktreePath ? "main" : null);

      for (const item of validatedItems) {
        if (item.filePath && item.startLine && worktreePath) {
          try {
            const fileDiff = await getAgentFileDiff(
              worktreePath,
              baseRef,
              item.filePath
            );
            if (fileDiff?.diff) {
              item.diffSnapshot = extractHunkAroundLines(
                fileDiff.diff,
                item.startLine,
                item.endLine ?? item.startLine
              );
            }
          } catch {
            // snapshot is best-effort
          }
        }
      }

      const review = await reviewQueries.createReview(deps.pool, {
        agentId,
        reviewerType: "human",
        summary:
          typeof body.summary === "string" ? body.summary.trim() || null : null,
        baseRef,
        items: validatedItems,
      });

      deps.publishUiEvent({
        type: "review.created",
        agentId,
        reviewId: review.id,
      });

      const assignedId = review.assignedAgentId ?? agentId;
      try {
        await deps.sendAgentPrompt(
          assignedId,
          buildReviewSubmittedPrompt({
            reviewId: review.id,
            reviewerName: "Human reviewer",
            summary: review.summary ?? "Feedback submitted for review.",
            items: review.items.map((item) => ({
              id: item.id,
              filePath: item.filePath,
              lineStart: item.lineStart,
              body: item.messages[0]?.content.body ?? "",
            })),
          })
        );
      } catch {
        // tmux delivery is best-effort
      }

      return { review };
    } catch (error) {
      return deps.handleAgentError(reply, error);
    }
  });

  app.patch(
    "/api/v1/agents/:id/reviews/items/:itemId",
    async (request, reply) => {
      const params = request.params as { id?: string; itemId?: string };
      const agentId = params.id ?? "";
      const itemId = Number(params.itemId ?? "");

      if (!Number.isInteger(itemId) || itemId <= 0) {
        return reply.code(400).send({ error: "Invalid item id." });
      }

      const body = request.body as {
        resolution?: unknown;
        note?: unknown;
      } | null;

      const validResolutions = ["fixed", "dismissed"] as const;
      if (
        body?.resolution !== null &&
        (typeof body?.resolution !== "string" ||
          !(validResolutions as readonly string[]).includes(body.resolution))
      ) {
        return reply.code(400).send({
          error: "resolution must be fixed, dismissed, or null",
        });
      }

      let note: string | null = null;
      if (typeof body.note === "string") {
        if (body.note.length > 10_000) {
          return reply
            .code(400)
            .send({ error: "note exceeds 10,000 character limit." });
        }
        note = body.note;
      }

      try {
        const agent = await deps.agentManager.getAgent(agentId);
        if (!agent) return reply.code(404).send({ error: "Agent not found." });

        const result =
          body.resolution === null
            ? await reviewQueries.reopenReviewFeedbackItem(
                deps.pool,
                itemId,
                agentId,
                { note, authorType: "human" }
              )
            : await reviewQueries.resolveReviewFeedbackItem(
                deps.pool,
                itemId,
                agentId,
                body.resolution as "fixed" | "dismissed",
                { note, authorType: "human" }
              );
        if (!result) {
          return reply.code(404).send({ error: "Feedback item not found." });
        }

        deps.publishUiEvent({
          type: "review_feedback.updated",
          agentId,
          feedbackItemId: result.item.id,
        });
        deps.publishUiEvent({
          type: "review.updated",
          agentId,
          reviewId: result.reviewId,
          status: result.reviewStatus,
        });

        const review = await reviewQueries.getReviewRecord(
          deps.pool,
          result.reviewId
        );
        const counterpartId = review?.reviewerAgentId
          ? review.reviewerAgentId
          : (review?.assignedAgentId ?? review?.agentId);
        if (counterpartId) {
          try {
            await deps.sendAgentPrompt(
              counterpartId,
              buildReviewItemStatePrompt({
                reviewId: result.reviewId,
                itemId,
                action: body.resolution === null ? "reopened" : "resolved",
                resolution:
                  body.resolution === null
                    ? null
                    : (body.resolution as "fixed" | "dismissed"),
                note,
              })
            );
          } catch {
            // tmux delivery is best-effort
          }
        }

        return { item: result.item };
      } catch (error) {
        return deps.handleAgentError(reply, error);
      }
    }
  );

  app.post(
    "/api/v1/agents/:id/reviews/items/:itemId/messages",
    async (request, reply) => {
      const params = request.params as { id?: string; itemId?: string };
      const agentId = params.id ?? "";
      const itemId = Number(params.itemId ?? "");

      if (!Number.isInteger(itemId) || itemId <= 0) {
        return reply.code(400).send({ error: "Invalid item id." });
      }

      const body = request.body as {
        body?: unknown;
      } | null;

      if (typeof body?.body !== "string" || !body.body.trim()) {
        return reply.code(400).send({ error: "body is required." });
      }
      if (body.body.length > 10_000) {
        return reply
          .code(400)
          .send({ error: "body exceeds 10,000 character limit." });
      }

      const authorType = "human" as const;

      try {
        const agent = await deps.agentManager.getAgent(agentId);
        if (!agent) return reply.code(404).send({ error: "Agent not found." });

        const result = await reviewQueries.addThreadMessage(
          deps.pool,
          itemId,
          agentId,
          authorType,
          body.body.trim()
        );
        if (!result) {
          return reply.code(404).send({ error: "Feedback item not found." });
        }

        deps.publishUiEvent({
          type: "review_feedback.updated",
          agentId,
          feedbackItemId: itemId,
        });

        const review = await reviewQueries.getReviewRecord(
          deps.pool,
          result.reviewId
        );
        const counterpartId = review?.reviewerAgentId
          ? review.reviewerAgentId
          : (review?.assignedAgentId ?? review?.agentId);
        if (counterpartId) {
          try {
            await deps.sendAgentPrompt(
              counterpartId,
              buildReviewThreadUpdatePrompt({
                reviewId: result.reviewId,
                itemId,
                from: "Human collaborator",
                body: body.body.trim(),
              })
            );
          } catch {
            // tmux delivery is best-effort
          }
        }

        return { message: result.message };
      } catch (error) {
        return deps.handleAgentError(reply, error);
      }
    }
  );

  app.get("/api/v1/agents/:id/reviews", async (request, reply) => {
    const params = request.params as { id?: string };
    const agentId = params.id ?? "";
    try {
      const agent = await deps.agentManager.getAgent(agentId);
      if (!agent) return reply.code(404).send({ error: "Agent not found." });
      const reviews = await reviewQueries.listReviews(deps.pool, agentId);
      return { reviews };
    } catch (error) {
      return deps.handleAgentError(reply, error);
    }
  });

  app.get(
    "/api/v1/agents/:id/reviews/feedback-items",
    async (request, reply) => {
      const params = request.params as { id?: string };
      const agentId = params.id ?? "";
      try {
        const agent = await deps.agentManager.getAgent(agentId);
        if (!agent) return reply.code(404).send({ error: "Agent not found." });
        const items = await reviewQueries.listFeedbackItemsForAgent(
          deps.pool,
          agentId
        );
        return { items };
      } catch (error) {
        return deps.handleAgentError(reply, error);
      }
    }
  );

  app.get("/api/v1/agents/:id/reviews/:reviewId", async (request, reply) => {
    const params = request.params as { id?: string; reviewId?: string };
    const agentId = params.id ?? "";
    const reviewId = Number(params.reviewId ?? "");

    if (!Number.isInteger(reviewId) || reviewId <= 0) {
      return reply.code(400).send({ error: "Invalid review id." });
    }

    try {
      const agent = await deps.agentManager.getAgent(agentId);
      if (!agent) return reply.code(404).send({ error: "Agent not found." });
      const review = await reviewQueries.getReview(
        deps.pool,
        agentId,
        reviewId
      );
      if (!review) return reply.code(404).send({ error: "Review not found." });
      return { review };
    } catch (error) {
      return deps.handleAgentError(reply, error);
    }
  });
}
