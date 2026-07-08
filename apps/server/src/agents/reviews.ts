import type { Pool } from "pg";

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

export type ReviewThreadMessageRecord = {
  id: number;
  feedbackItemId: number;
  authorType: string;
  authorAgentId: string | null;
  type: string;
  content: { body: string };
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
      `INSERT INTO reviews (agent_id, assigned_agent_id, reviewer_type, reviewer_agent_id, summary, base_ref)
       VALUES ($1, $2, $3, $4, $5, $6)
       ${REVIEW_RETURNING}`,
      [
        input.agentId,
        input.assignedAgentId ?? input.agentId,
        input.reviewerType,
        input.reviewerAgentId ?? null,
        input.summary ?? null,
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

export type ReviewListItem = ReviewRecord & {
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
            COUNT(fi.id)::int AS "itemCount",
            COUNT(fi.id) FILTER (WHERE fi.status = 'resolved')::int AS "resolvedCount"
     FROM reviews r
     LEFT JOIN review_feedback_items fi ON fi.review_id = r.id
     WHERE r.agent_id = $1
     GROUP BY r.id
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

  const items: ReviewWithItems["items"] = [];
  for (const item of itemsResult.rows) {
    const messagesResult = await pool.query<ReviewThreadMessageRecord>(
      `SELECT ${THREAD_MESSAGE_SELECT} FROM review_thread_messages WHERE feedback_item_id = $1 ORDER BY created_at ASC`,
      [item.id]
    );
    items.push({ ...item, messages: messagesResult.rows });
  }

  return { ...review, items };
}

export async function listFeedbackItemsForAgent(
  pool: Pool,
  agentId: string
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
     WHERE r.agent_id = $1
     ORDER BY fi.created_at ASC`,
    [agentId]
  );

  const items: Array<
    ReviewFeedbackItemRecord & {
      reviewId: number;
      messages: ReviewThreadMessageRecord[];
    }
  > = [];

  for (const item of itemsResult.rows) {
    const messagesResult = await pool.query<ReviewThreadMessageRecord>(
      `SELECT ${THREAD_MESSAGE_SELECT} FROM review_thread_messages WHERE feedback_item_id = $1 ORDER BY created_at ASC`,
      [item.id]
    );
    items.push({ ...item, messages: messagesResult.rows });
  }

  return items;
}
