import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";

import type { AgentManager } from "../agents/manager.js";
import type { UiEvent } from "../server/ui-events.js";
import * as reviewQueries from "../agents/reviews.js";
import { getAgentFileDiff } from "../shared/git/agent-diff.js";
import { extractHunkAroundLines } from "../shared/lib/extract-hunk.js";
import { AGENT_REVIEW_REPLY_GUIDANCE } from "../shared/review-limits.js";

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

      // Send tmux notification to the agent
      const assignedId = review.assignedAgentId ?? agentId;
      const notifLines = [
        "--- DISPATCH: Review Submitted ---",
        "Reviewer: human",
      ];
      if (review.summary) {
        notifLines.push(`Summary: ${review.summary}`);
      }
      notifLines.push(`Feedback items (${review.items.length}):`);
      notifLines.push("");
      for (let i = 0; i < review.items.length; i++) {
        const it = review.items[i]!;
        const msg = it.messages[0]?.content?.body ?? "";
        if (it.filePath && it.lineStart) {
          const lineRef =
            it.lineEnd && it.lineEnd !== it.lineStart
              ? `${it.lineStart}-${it.lineEnd}`
              : `${it.lineStart}`;
          notifLines.push(`${i + 1}. ${it.filePath}:${lineRef} — ${msg}`);
        } else {
          notifLines.push(`${i + 1}. General — ${msg}`);
        }
      }
      notifLines.push("");
      notifLines.push("How to handle this review:");
      notifLines.push(
        "1. Call dispatch_review_list_feedback to see all feedback items and their IDs."
      );
      notifLines.push(
        "2. Read each feedback item. For each one, decide whether to fix it, push back, or dismiss it."
      );
      notifLines.push(
        `3. If a reply is useful, use dispatch_review_add_message on that item's thread. ${AGENT_REVIEW_REPLY_GUIDANCE}`
      );
      notifLines.push(
        "4. After addressing an item (or deciding not to), call dispatch_review_resolve to mark it as fixed or dismissed. Include a brief note when dismissing so the reviewer understands why."
      );
      notifLines.push(
        "5. Work through all items — the review status updates automatically as you resolve each one."
      );
      notifLines.push("--- END ---");

      try {
        await deps.sendAgentPrompt(assignedId, notifLines.join("\n"));
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
                agentId
              )
            : await reviewQueries.resolveReviewFeedbackItem(
                deps.pool,
                itemId,
                agentId,
                body.resolution as "fixed" | "dismissed",
                { note }
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

        try {
          await deps.sendAgentPrompt(
            agentId,
            [
              "--- DISPATCH: Review Thread Reply ---",
              `Feedback item #${itemId}: ${body.body.trim()}`,
              `Reply only if useful. ${AGENT_REVIEW_REPLY_GUIDANCE}`,
              "--- END ---",
            ].join("\n")
          );
        } catch {
          // tmux delivery is best-effort
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
