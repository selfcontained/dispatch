import type { FastifyInstance } from "fastify";

import { getAgentFileDiff } from "../../shared/git/agent-diff.js";
import {
  createReview,
  listReviews,
  getReview,
  listFeedbackItemsForAgent,
  type CreateReviewInput,
} from "../../agents/reviews.js";
import type { AgentRouteDeps } from "./shared.js";

export async function registerAgentReviewRoutes(
  app: FastifyInstance,
  deps: AgentRouteDeps
): Promise<void> {
  // --- POST /api/v1/agents/:id/reviews — Submit a review ---
  app.post("/api/v1/agents/:id/reviews", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";

    const body = request.body as {
      summary?: string;
      items?: Array<{
        filePath?: string;
        startLine?: number;
        endLine?: number;
        comment?: string;
      }>;
    } | null;

    // Validate items
    if (!Array.isArray(body?.items) || body.items.length === 0) {
      return reply
        .code(400)
        .send({ error: "At least one feedback item is required." });
    }

    // Validate each item
    for (let i = 0; i < body.items.length; i++) {
      const item = body.items[i]!;
      if (
        !item.comment ||
        typeof item.comment !== "string" ||
        !item.comment.trim()
      ) {
        return reply
          .code(400)
          .send({ error: `Item ${i + 1}: comment is required.` });
      }
      if (item.comment.length > 10_000) {
        return reply
          .code(400)
          .send({ error: `Item ${i + 1}: comment too long.` });
      }
      if (item.filePath !== undefined && typeof item.filePath !== "string") {
        return reply
          .code(400)
          .send({ error: `Item ${i + 1}: invalid filePath.` });
      }
      if (item.filePath && item.filePath.includes("..")) {
        return reply
          .code(400)
          .send({ error: `Item ${i + 1}: invalid file path.` });
      }
      if (
        item.startLine !== undefined &&
        (typeof item.startLine !== "number" ||
          !Number.isInteger(item.startLine) ||
          item.startLine < 1)
      ) {
        return reply
          .code(400)
          .send({ error: `Item ${i + 1}: invalid startLine.` });
      }
      if (
        item.endLine !== undefined &&
        (typeof item.endLine !== "number" ||
          !Number.isInteger(item.endLine) ||
          item.endLine < 1)
      ) {
        return reply
          .code(400)
          .send({ error: `Item ${i + 1}: invalid endLine.` });
      }
      if (
        item.startLine !== undefined &&
        item.endLine !== undefined &&
        item.endLine < item.startLine
      ) {
        return reply
          .code(400)
          .send({ error: `Item ${i + 1}: endLine must be >= startLine.` });
      }
    }

    if (body.summary !== undefined && typeof body.summary !== "string") {
      return reply.code(400).send({ error: "summary must be a string." });
    }
    if (body.summary && body.summary.length > 10_000) {
      return reply.code(400).send({ error: "Summary too long." });
    }

    const agent = await deps.agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    // Resolve worktree path for diff snapshot
    const gitContextWorktreePath = agent.gitContext?.isWorktree
      ? agent.gitContext.worktreePath
      : null;
    const worktreePath =
      agent.worktreePath ?? gitContextWorktreePath ?? agent.cwd ?? null;
    const baseRef =
      agent.baseBranch ??
      (agent.worktreePath || gitContextWorktreePath ? "main" : null);

    // Build items with diff snapshots
    const reviewItems: CreateReviewInput["items"] = [];
    for (const item of body.items) {
      let diffSnapshot: string | undefined;

      if (item.filePath && worktreePath) {
        try {
          const fileDiff = await getAgentFileDiff(
            worktreePath,
            baseRef,
            item.filePath
          );
          if (
            fileDiff &&
            item.startLine !== undefined &&
            item.endLine !== undefined
          ) {
            // Extract the relevant hunk around the selected lines
            diffSnapshot = extractHunkAroundLines(
              fileDiff.diff,
              item.startLine,
              item.endLine
            );
          } else if (fileDiff) {
            // General file comment — snapshot the whole diff (truncated)
            diffSnapshot =
              fileDiff.diff.length > 5_000
                ? fileDiff.diff.slice(0, 5_000) + "\n... (truncated)"
                : fileDiff.diff;
          }
        } catch {
          // Diff snapshot is best-effort — don't fail the review
        }
      }

      reviewItems.push({
        filePath: item.filePath,
        lineStart: item.startLine,
        lineEnd: item.endLine,
        diffSnapshot,
        comment: item.comment!.trim(),
      });
    }

    try {
      const review = await createReview(deps.pool, {
        agentId: id,
        assignedAgentId: id,
        reviewerType: "human",
        reviewerAgentId: null,
        summary: body.summary?.trim() || null,
        baseRef: baseRef,
        items: reviewItems,
      });

      // Publish SSE event
      deps.publishUiEvent({
        type: "review.created",
        agentId: id,
        reviewId: review.id,
      } as never);

      // Send tmux notification to the assigned agent
      try {
        const notification = formatReviewNotification(review, reviewItems);
        await deps.sendAgentPrompt(id, notification);
      } catch (err) {
        deps.appLog.warn(
          { err, agentId: id, reviewId: review.id },
          "Review created but tmux notification failed"
        );
      }

      return { review };
    } catch (error) {
      return deps.handleAgentError(reply, error);
    }
  });

  // --- GET /api/v1/agents/:id/reviews — List reviews for an agent ---
  app.get("/api/v1/agents/:id/reviews", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";

    const agent = await deps.agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    try {
      const reviews = await listReviews(deps.pool, id);
      return { reviews };
    } catch (error) {
      return deps.handleAgentError(reply, error);
    }
  });

  // --- GET /api/v1/agents/:id/reviews/feedback --- All feedback items for inline annotations
  // Registered before the :reviewId route so "feedback" isn't captured as a param
  app.get("/api/v1/agents/:id/reviews/feedback", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";

    const agent = await deps.agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    try {
      const items = await listFeedbackItemsForAgent(deps.pool, id);
      return { items };
    } catch (error) {
      return deps.handleAgentError(reply, error);
    }
  });

  // --- GET /api/v1/agents/:id/reviews/:reviewId — Get review detail ---
  app.get("/api/v1/agents/:id/reviews/:reviewId", async (request, reply) => {
    const params = request.params as { id?: string; reviewId?: string };
    const id = params.id ?? "";
    const reviewId = params.reviewId ?? "";

    if (!reviewId) {
      return reply.code(400).send({ error: "Review ID is required." });
    }

    const agent = await deps.agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    try {
      const review = await getReview(deps.pool, reviewId);
      if (!review || review.agentId !== id) {
        return reply.code(404).send({ error: "Review not found." });
      }
      return { review };
    } catch (error) {
      return deps.handleAgentError(reply, error);
    }
  });
}

/**
 * Extract the diff hunk(s) that contain the given line range.
 * Returns the relevant portion of the unified diff for snapshotting.
 */
function extractHunkAroundLines(
  diffText: string,
  startLine: number,
  endLine: number
): string {
  const lines = diffText.split("\n");
  const result: string[] = [];
  let newLineNum = 0;
  let inRelevantHunk = false;
  let hunkHeader = "";

  for (const line of lines) {
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      newLineNum = parseInt(hunkMatch[1]!, 10) - 1;
      hunkHeader = line;
      inRelevantHunk = false;
      continue;
    }

    if (newLineNum === 0) continue;

    if (line.startsWith("-")) {
      if (inRelevantHunk) result.push(line);
      continue;
    }

    if (line.startsWith("+") || line.startsWith(" ")) {
      newLineNum++;
      if (newLineNum >= startLine && newLineNum <= endLine) {
        if (!inRelevantHunk) {
          if (hunkHeader) result.push(hunkHeader);
          inRelevantHunk = true;
        }
        result.push(line);
      } else if (inRelevantHunk) {
        // Include a few trailing context lines
        result.push(line);
        if (newLineNum > endLine + 3) {
          inRelevantHunk = false;
        }
      }
    }
  }

  return result.join("\n");
}

/**
 * Format the tmux notification message for a submitted review.
 */
function formatReviewNotification(
  review: { summary: string | null },
  items: Array<{
    filePath?: string;
    lineStart?: number;
    lineEnd?: number;
    comment: string;
  }>
): string {
  const parts: string[] = [
    "--- DISPATCH: Review Submitted ---",
    "Reviewer: human",
  ];

  if (review.summary) {
    parts.push(`Summary: ${review.summary}`);
  }

  parts.push(`Feedback items (${items.length}):`);
  parts.push("");

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    let location: string;
    if (item.filePath && item.lineStart !== undefined) {
      const lineRef =
        item.lineEnd !== undefined && item.lineEnd !== item.lineStart
          ? `${item.lineStart}-${item.lineEnd}`
          : `${item.lineStart}`;
      location = `${item.filePath}:${lineRef}`;
    } else if (item.filePath) {
      location = item.filePath;
    } else {
      location = "General";
    }

    // Truncate comment for notification summary
    const shortComment =
      item.comment.length > 120
        ? item.comment.slice(0, 117) + "..."
        : item.comment;
    parts.push(`${i + 1}. ${location} — ${shortComment}`);
  }

  parts.push("");
  parts.push(
    "Use dispatch_list_review_feedback to see full details and work through items."
  );
  parts.push("--- END ---");

  return parts.join("\n");
}
