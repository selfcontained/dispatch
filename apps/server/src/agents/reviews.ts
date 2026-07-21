import type { Pool, PoolClient } from "pg";

import { AGENT_REVIEW_REPLY_MAX_CHARS } from "../shared/review-limits.js";

export type ReviewRecord = {
  id: number;
  agentId: string;
  assignedAgentId: string | null;
  reviewerType: string;
  reviewerAgentId: string | null;
  summary: string | null;
  status: string;
  baseRef: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ReviewFeedbackItemRecord = {
  id: number;
  reviewId: number;
  filePath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  diffSnapshot: string | null;
  baseRef: string | null;
  status: string;
  resolution: string | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ReviewFeedbackResolverRole = "reviewer" | "assignee" | "human";

export class ReviewFeedbackResolutionConflictError extends Error {
  constructor(public readonly item: ReviewFeedbackItemRecord) {
    const resolution = item.resolution ? ` (${item.resolution})` : "";
    super(
      `Review feedback item #${item.id} is already ${item.status}${resolution}; refresh the review before acting.`
    );
    this.name = "ReviewFeedbackResolutionConflictError";
  }
}

export type ReviewThreadMessageRecord = {
  id: number;
  feedbackItemId: number;
  authorType: string;
  authorAgentId: string | null;
  type: string;
  content: { body: string; resolution?: "fixed" | "dismissed" | null };
  createdAt: string;
};

const REVIEW_SELECT = `
  id, agent_id AS "agentId", assigned_agent_id AS "assignedAgentId",
  reviewer_type AS "reviewerType", reviewer_agent_id AS "reviewerAgentId",
  summary, status, base_ref AS "baseRef",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

const REVIEW_RETURNING = `
  RETURNING ${REVIEW_SELECT}
`;

const FEEDBACK_ITEM_SELECT = `
  id, review_id AS "reviewId", file_path AS "filePath",
  line_start AS "lineStart", line_end AS "lineEnd",
  diff_snapshot AS "diffSnapshot", base_ref AS "baseRef",
  status, resolution, resolution_note AS "resolutionNote",
  resolved_by AS "resolvedBy", resolved_at AS "resolvedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

const FEEDBACK_ITEM_RETURNING = `
  RETURNING ${FEEDBACK_ITEM_SELECT}
`;

const THREAD_MESSAGE_SELECT = `
  id, feedback_item_id AS "feedbackItemId",
  author_type AS "authorType", author_agent_id AS "authorAgentId",
  type, content, created_at AS "createdAt"
`;

const THREAD_MESSAGE_RETURNING = `
  RETURNING ${THREAD_MESSAGE_SELECT}
`;

export type CreateReviewInput = {
  agentId: string;
  assignedAgentId?: string | null;
  reviewerType: "human" | "agent";
  reviewerAgentId?: string | null;
  summary?: string | null;
  baseRef?: string | null;
  items: Array<{
    filePath?: string | null;
    startLine?: number | null;
    endLine?: number | null;
    comment: string;
    diffSnapshot?: string | null;
  }>;
};

export type ReviewWithItems = ReviewRecord & {
  items: Array<
    ReviewFeedbackItemRecord & {
      messages: ReviewThreadMessageRecord[];
    }
  >;
};

export async function createReview(
  pool: Pool,
  input: CreateReviewInput
): Promise<ReviewWithItems> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const reviewResult = await client.query<ReviewRecord>(
      `INSERT INTO reviews (agent_id, assigned_agent_id, reviewer_type, reviewer_agent_id, summary, status, base_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ${REVIEW_RETURNING}`,
      [
        input.agentId,
        input.assignedAgentId ?? input.agentId,
        input.reviewerType,
        input.reviewerAgentId ?? null,
        input.summary ?? null,
        input.items.length === 0 ? "resolved" : "open",
        input.baseRef ?? null,
      ]
    );
    const review = reviewResult.rows[0]!;

    const items: ReviewWithItems["items"] = [];

    for (const item of input.items) {
      const itemResult = await client.query<ReviewFeedbackItemRecord>(
        `INSERT INTO review_feedback_items (review_id, file_path, line_start, line_end, diff_snapshot, base_ref)
         VALUES ($1, $2, $3, $4, $5, $6)
         ${FEEDBACK_ITEM_RETURNING}`,
        [
          review.id,
          item.filePath ?? null,
          item.startLine ?? null,
          item.endLine ?? null,
          item.diffSnapshot ?? null,
          input.baseRef ?? null,
        ]
      );
      const feedbackItem = itemResult.rows[0]!;

      const messageResult = await client.query<ReviewThreadMessageRecord>(
        `INSERT INTO review_thread_messages (feedback_item_id, author_type, author_agent_id, type, content)
         VALUES ($1, $2, $3, 'text', $4)
         ${THREAD_MESSAGE_RETURNING}`,
        [
          feedbackItem.id,
          input.reviewerType,
          input.reviewerAgentId ?? null,
          JSON.stringify({ body: item.comment }),
        ]
      );

      items.push({
        ...feedbackItem,
        messages: [messageResult.rows[0]!],
      });
    }

    await client.query("COMMIT");
    return { ...review, items };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getReviewByReviewerAgent(
  pool: Pool,
  reviewerAgentId: string
): Promise<ReviewRecord | null> {
  const result = await pool.query<ReviewRecord>(
    `SELECT ${REVIEW_SELECT}
     FROM reviews
     WHERE reviewer_type = 'agent' AND reviewer_agent_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [reviewerAgentId]
  );
  return result.rows[0] ?? null;
}

export async function getReviewRecord(
  pool: Pool,
  reviewId: number
): Promise<ReviewRecord | null> {
  const result = await pool.query<ReviewRecord>(
    `SELECT ${REVIEW_SELECT} FROM reviews WHERE id = $1`,
    [reviewId]
  );
  return result.rows[0] ?? null;
}

async function recomputeReviewStatus(
  client: PoolClient,
  reviewId: number
): Promise<string> {
  const countsResult = await client.query<{ total: number; resolved: number }>(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'resolved')::int AS resolved
     FROM review_feedback_items WHERE review_id = $1`,
    [reviewId]
  );
  const { total, resolved } = countsResult.rows[0]!;
  const status =
    total === 0 || resolved === total
      ? "resolved"
      : resolved > 0
        ? "partially_resolved"
        : "open";
  await client.query(
    `UPDATE reviews SET status = $1, updated_at = NOW() WHERE id = $2`,
    [status, reviewId]
  );
  return status;
}

export async function addReviewFeedbackItem(
  pool: Pool,
  reviewId: number,
  reviewerAgentId: string,
  item: CreateReviewInput["items"][number]
): Promise<{
  item: ReviewFeedbackItemRecord & { messages: ReviewThreadMessageRecord[] };
  reviewStatus: string;
} | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const review = await client.query<{ baseRef: string | null }>(
      `SELECT base_ref AS "baseRef"
       FROM reviews
       WHERE id = $1 AND reviewer_type = 'agent' AND reviewer_agent_id = $2
       FOR UPDATE`,
      [reviewId, reviewerAgentId]
    );
    if (!review.rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }

    const itemResult = await client.query<ReviewFeedbackItemRecord>(
      `INSERT INTO review_feedback_items
         (review_id, file_path, line_start, line_end, diff_snapshot, base_ref)
       VALUES ($1, $2, $3, $4, $5, $6)
       ${FEEDBACK_ITEM_RETURNING}`,
      [
        reviewId,
        item.filePath ?? null,
        item.startLine ?? null,
        item.endLine ?? null,
        item.diffSnapshot ?? null,
        review.rows[0].baseRef,
      ]
    );
    const feedbackItem = itemResult.rows[0]!;
    const messageResult = await client.query<ReviewThreadMessageRecord>(
      `INSERT INTO review_thread_messages
         (feedback_item_id, author_type, author_agent_id, type, content)
       VALUES ($1, 'agent', $2, 'text', $3)
       ${THREAD_MESSAGE_RETURNING}`,
      [feedbackItem.id, reviewerAgentId, JSON.stringify({ body: item.comment })]
    );
    const reviewStatus = await recomputeReviewStatus(client, reviewId);
    await client.query("COMMIT");
    return {
      item: { ...feedbackItem, messages: [messageResult.rows[0]!] },
      reviewStatus,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type ReviewListItem = ReviewRecord & {
  reviewerName: string | null;
  itemCount: number;
  resolvedCount: number;
};

export async function listReviews(
  pool: Pool,
  agentId: string
): Promise<ReviewListItem[]> {
  const result = await pool.query<ReviewListItem>(
    `SELECT r.id, r.agent_id AS "agentId", r.assigned_agent_id AS "assignedAgentId",
            r.reviewer_type AS "reviewerType", r.reviewer_agent_id AS "reviewerAgentId",
            r.summary, r.status, r.base_ref AS "baseRef",
            r.created_at AS "createdAt", r.updated_at AS "updatedAt",
            COALESCE(reviewer.persona, reviewer.name) AS "reviewerName",
            COUNT(fi.id)::int AS "itemCount",
            COUNT(fi.id) FILTER (WHERE fi.status = 'resolved')::int AS "resolvedCount"
     FROM reviews r
     LEFT JOIN agents reviewer ON reviewer.id = r.reviewer_agent_id
     LEFT JOIN review_feedback_items fi ON fi.review_id = r.id
     WHERE r.agent_id = $1
     GROUP BY r.id, reviewer.persona, reviewer.name
     ORDER BY r.created_at DESC`,
    [agentId]
  );
  return result.rows;
}

export async function getReview(
  pool: Pool,
  agentId: string,
  reviewId: number
): Promise<ReviewWithItems | null> {
  const reviewResult = await pool.query<ReviewRecord>(
    `SELECT ${REVIEW_SELECT} FROM reviews WHERE id = $1 AND agent_id = $2`,
    [reviewId, agentId]
  );
  const review = reviewResult.rows[0];
  if (!review) return null;

  const itemsResult = await pool.query<ReviewFeedbackItemRecord>(
    `SELECT ${FEEDBACK_ITEM_SELECT} FROM review_feedback_items WHERE review_id = $1 ORDER BY id ASC`,
    [reviewId]
  );

  const itemIds = itemsResult.rows.map((i) => i.id);
  const messagesByItem = new Map<number, ReviewThreadMessageRecord[]>();

  if (itemIds.length > 0) {
    const messagesResult = await pool.query<
      ReviewThreadMessageRecord & { feedbackItemId: number }
    >(
      `SELECT ${THREAD_MESSAGE_SELECT}, feedback_item_id AS "feedbackItemId"
       FROM review_thread_messages
       WHERE feedback_item_id = ANY($1)
       ORDER BY created_at ASC`,
      [itemIds]
    );
    for (const msg of messagesResult.rows) {
      const list = messagesByItem.get(msg.feedbackItemId) ?? [];
      list.push(msg);
      messagesByItem.set(msg.feedbackItemId, list);
    }
  }

  const items = itemsResult.rows.map((item) => ({
    ...item,
    messages: messagesByItem.get(item.id) ?? [],
  }));

  return { ...review, items };
}

export async function resolveReviewFeedbackItem(
  pool: Pool,
  itemId: number,
  agentId: string,
  resolution: "fixed" | "dismissed",
  opts: {
    note?: string | null;
    resolvedBy?: string | null;
    authorType?: "human" | "agent";
    resolverRole: ReviewFeedbackResolverRole;
  }
): Promise<{
  item: ReviewFeedbackItemRecord;
  reviewId: number;
  reviewStatus: string;
} | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const itemResult = await client.query<
      ReviewFeedbackItemRecord & { agentId: string }
    >(
      `UPDATE review_feedback_items fi
       SET status = 'resolved', resolution = $1, resolution_note = $2,
           resolved_by = $3, resolved_at = NOW(), updated_at = NOW()
       FROM reviews r
       WHERE fi.id = $4 AND fi.review_id = r.id
         AND fi.status = 'open'
         AND (
           (($6 = 'human' OR $6 = 'assignee')
               AND (r.agent_id = $5 OR r.assigned_agent_id = $5))
           OR ($6 = 'reviewer' AND r.reviewer_type = 'agent' AND r.reviewer_agent_id = $5)
         )
       RETURNING
         fi.id, fi.review_id AS "reviewId", fi.file_path AS "filePath",
         fi.line_start AS "lineStart", fi.line_end AS "lineEnd",
         fi.diff_snapshot AS "diffSnapshot", fi.base_ref AS "baseRef",
         fi.status, fi.resolution, fi.resolution_note AS "resolutionNote",
         fi.resolved_by AS "resolvedBy", fi.resolved_at AS "resolvedAt",
         fi.created_at AS "createdAt", fi.updated_at AS "updatedAt",
         r.agent_id AS "agentId"`,
      [
        resolution,
        opts.note ?? null,
        opts.resolvedBy ?? null,
        itemId,
        agentId,
        opts.resolverRole,
      ]
    );
    const item = itemResult.rows[0];
    if (!item) {
      const currentResult = await client.query<ReviewFeedbackItemRecord>(
        `SELECT fi.id, fi.review_id AS "reviewId", fi.file_path AS "filePath",
                fi.line_start AS "lineStart", fi.line_end AS "lineEnd",
                fi.diff_snapshot AS "diffSnapshot", fi.base_ref AS "baseRef",
                fi.status, fi.resolution, fi.resolution_note AS "resolutionNote",
                fi.resolved_by AS "resolvedBy", fi.resolved_at AS "resolvedAt",
                fi.created_at AS "createdAt", fi.updated_at AS "updatedAt"
         FROM review_feedback_items fi
         JOIN reviews r ON r.id = fi.review_id
         WHERE fi.id = $1
           AND (
             (($3 = 'human' OR $3 = 'assignee')
                 AND (r.agent_id = $2 OR r.assigned_agent_id = $2))
             OR ($3 = 'reviewer' AND r.reviewer_type = 'agent' AND r.reviewer_agent_id = $2)
           )`,
        [itemId, agentId, opts.resolverRole]
      );
      const currentItem = currentResult.rows[0];
      if (currentItem && currentItem.status !== "open") {
        throw new ReviewFeedbackResolutionConflictError(currentItem);
      }
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      `INSERT INTO review_thread_messages
         (feedback_item_id, author_type, author_agent_id, type, content)
       VALUES ($1, $2, $3, 'resolution', $4)`,
      [
        itemId,
        opts.authorType ?? "agent",
        opts.resolvedBy ?? null,
        JSON.stringify({
          body: opts.note?.trim() ?? "",
          resolution,
        }),
      ]
    );
    const newReviewStatus = await recomputeReviewStatus(client, item.reviewId);

    await client.query("COMMIT");
    return { item, reviewId: item.reviewId, reviewStatus: newReviewStatus };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function reopenReviewFeedbackItem(
  pool: Pool,
  itemId: number,
  agentId: string,
  opts: {
    note?: string | null;
    reopenedBy?: string | null;
    authorType?: "human" | "agent";
  } = {}
): Promise<{
  item: ReviewFeedbackItemRecord;
  reviewId: number;
  reviewStatus: string;
} | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const itemResult = await client.query<ReviewFeedbackItemRecord>(
      `UPDATE review_feedback_items fi
       SET status = 'open', resolution = NULL, resolution_note = NULL,
           resolved_by = NULL, resolved_at = NULL, updated_at = NOW()
       FROM reviews r
       WHERE fi.id = $1 AND fi.review_id = r.id
         AND (r.agent_id = $2 OR r.assigned_agent_id = $2)
       RETURNING
         fi.id, fi.review_id AS "reviewId", fi.file_path AS "filePath",
         fi.line_start AS "lineStart", fi.line_end AS "lineEnd",
         fi.diff_snapshot AS "diffSnapshot", fi.base_ref AS "baseRef",
         fi.status, fi.resolution, fi.resolution_note AS "resolutionNote",
         fi.resolved_by AS "resolvedBy", fi.resolved_at AS "resolvedAt",
         fi.created_at AS "createdAt", fi.updated_at AS "updatedAt"`,
      [itemId, agentId]
    );
    const item = itemResult.rows[0];
    if (!item) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      `INSERT INTO review_thread_messages
         (feedback_item_id, author_type, author_agent_id, type, content)
       VALUES ($1, $2, $3, 'reopen', $4)`,
      [
        itemId,
        opts.authorType ?? "agent",
        opts.reopenedBy ?? null,
        JSON.stringify({ body: opts.note?.trim() ?? "", resolution: null }),
      ]
    );
    const reviewStatus = await recomputeReviewStatus(client, item.reviewId);
    await client.query("COMMIT");
    return { item, reviewId: item.reviewId, reviewStatus };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function addThreadMessage(
  pool: Pool,
  itemId: number,
  agentId: string,
  authorType: "human" | "agent",
  body: string,
  authorAgentId?: string | null
): Promise<{ message: ReviewThreadMessageRecord; reviewId: number } | null> {
  if (authorType === "agent" && body.length > AGENT_REVIEW_REPLY_MAX_CHARS) {
    throw new Error(
      `Agent review thread replies must be ${AGENT_REVIEW_REPLY_MAX_CHARS} characters or fewer.`
    );
  }
  const ownership = await pool.query<{ reviewId: number }>(
    `SELECT fi.review_id AS "reviewId"
     FROM review_feedback_items fi
     JOIN reviews r ON r.id = fi.review_id
     WHERE fi.id = $1
       AND (r.agent_id = $2 OR r.assigned_agent_id = $2 OR r.reviewer_agent_id = $2)`,
    [itemId, agentId]
  );
  if (ownership.rows.length === 0) return null;

  const result = await pool.query<ReviewThreadMessageRecord>(
    `INSERT INTO review_thread_messages (feedback_item_id, author_type, author_agent_id, type, content)
     VALUES ($1, $2, $3, 'text', $4)
     ${THREAD_MESSAGE_RETURNING}`,
    [itemId, authorType, authorAgentId ?? null, JSON.stringify({ body })]
  );

  return {
    message: result.rows[0]!,
    reviewId: ownership.rows[0]!.reviewId,
  };
}

export async function listFeedbackItemsForAgent(
  pool: Pool,
  agentId: string,
  reviewId?: number
): Promise<
  Array<
    ReviewFeedbackItemRecord & {
      reviewId: number;
      messages: ReviewThreadMessageRecord[];
    }
  >
> {
  const itemsResult = await pool.query<
    ReviewFeedbackItemRecord & { reviewId: number }
  >(
    `SELECT fi.id, fi.review_id AS "reviewId", fi.file_path AS "filePath",
            fi.line_start AS "lineStart", fi.line_end AS "lineEnd",
            fi.diff_snapshot AS "diffSnapshot", fi.base_ref AS "baseRef",
            fi.status, fi.resolution, fi.resolution_note AS "resolutionNote",
            fi.resolved_by AS "resolvedBy", fi.resolved_at AS "resolvedAt",
            fi.created_at AS "createdAt", fi.updated_at AS "updatedAt"
     FROM review_feedback_items fi
     JOIN reviews r ON r.id = fi.review_id
     WHERE (r.agent_id = $1 OR r.assigned_agent_id = $1 OR r.reviewer_agent_id = $1)
       AND ($2::int IS NULL OR r.id = $2)
     ORDER BY fi.created_at ASC`,
    [agentId, reviewId ?? null]
  );

  const itemIds = itemsResult.rows.map((i) => i.id);
  const messagesByItem = new Map<number, ReviewThreadMessageRecord[]>();

  if (itemIds.length > 0) {
    const messagesResult = await pool.query<
      ReviewThreadMessageRecord & { feedbackItemId: number }
    >(
      `SELECT ${THREAD_MESSAGE_SELECT}, feedback_item_id AS "feedbackItemId"
       FROM review_thread_messages
       WHERE feedback_item_id = ANY($1)
       ORDER BY created_at ASC`,
      [itemIds]
    );
    for (const msg of messagesResult.rows) {
      const list = messagesByItem.get(msg.feedbackItemId) ?? [];
      list.push(msg);
      messagesByItem.set(msg.feedbackItemId, list);
    }
  }

  return itemsResult.rows.map((item) => ({
    ...item,
    messages: messagesByItem.get(item.id) ?? [],
  }));
}
