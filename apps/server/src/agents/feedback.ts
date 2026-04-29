import type { Pool } from "pg";

import { AgentError } from "./errors.js";
import { resolveFeedbackRoundNumber } from "./persona-reviews.js";

export type FeedbackInput = {
  severity?: "critical" | "high" | "medium" | "low" | "info";
  filePath?: string;
  lineNumber?: number;
  description: string;
  suggestion?: string;
  mediaRef?: string;
  respondsToFeedbackId?: number;
};

export type FeedbackRecord = {
  id: number;
  agentId: string;
  severity: string;
  filePath: string | null;
  lineNumber: number | null;
  description: string;
  suggestion: string | null;
  mediaRef: string | null;
  status: string;
  resolutionReason: string | null;
  resolutionCommit: string | null;
  resolvedAt: string | null;
  roundNumber: number;
  respondsToFeedbackId: number | null;
  createdAt: string;
};

const FEEDBACK_RETURNING = `
  RETURNING id, agent_id AS "agentId", severity, file_path AS "filePath",
            line_number AS "lineNumber",
            description, suggestion, media_ref AS "mediaRef", status,
            resolution_reason AS "resolutionReason",
            resolution_commit AS "resolutionCommit",
            resolved_at AS "resolvedAt",
            round_number AS "roundNumber",
            responds_to_feedback_id AS "respondsToFeedbackId",
            created_at AS "createdAt"
`;

const FEEDBACK_SELECT_COLUMNS = `
  id, agent_id AS "agentId", severity, file_path AS "filePath",
  line_number AS "lineNumber",
  description, suggestion, media_ref AS "mediaRef", status,
  resolution_reason AS "resolutionReason",
  resolution_commit AS "resolutionCommit",
  resolved_at AS "resolvedAt",
  round_number AS "roundNumber",
  responds_to_feedback_id AS "respondsToFeedbackId",
  created_at AS "createdAt"
`;

export async function submitFeedback(
  pool: Pool,
  agentId: string,
  feedback: FeedbackInput
): Promise<FeedbackRecord> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const feedbackRoundNumber = await resolveFeedbackRoundNumber(
      client,
      agentId
    );

    if (feedback.respondsToFeedbackId != null) {
      const originalResult = await client.query<{
        agentId: string;
        roundNumber: number;
      }>(
        `SELECT agent_id AS "agentId", round_number AS "roundNumber"
           FROM agent_feedback
           WHERE id = $1`,
        [feedback.respondsToFeedbackId]
      );
      const original = originalResult.rows[0];
      if (!original) {
        throw new AgentError(
          `Feedback ${feedback.respondsToFeedbackId} referenced by respondsToFeedbackId was not found.`,
          400
        );
      }
      if (original.agentId !== agentId) {
        throw new AgentError(
          `respondsToFeedbackId ${feedback.respondsToFeedbackId} belongs to a different review.`,
          400
        );
      }
      if (original.roundNumber !== 1) {
        throw new AgentError(
          `respondsToFeedbackId ${feedback.respondsToFeedbackId} must reference a round-1 finding.`,
          400
        );
      }
    }

    const result = await client.query<FeedbackRecord>(
      `INSERT INTO agent_feedback (
           agent_id,
           severity,
           file_path,
           line_number,
           description,
           suggestion,
           media_ref,
           round_number,
           responds_to_feedback_id
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ${FEEDBACK_RETURNING}`,
      [
        agentId,
        feedback.severity ?? "info",
        feedback.filePath ?? null,
        feedback.lineNumber ?? null,
        feedback.description,
        feedback.suggestion ?? null,
        feedback.mediaRef ?? null,
        feedbackRoundNumber,
        feedback.respondsToFeedbackId ?? null,
      ]
    );

    await client.query("COMMIT");
    return result.rows[0]!;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listFeedback(
  pool: Pool,
  agentId: string
): Promise<FeedbackRecord[]> {
  const result = await pool.query<FeedbackRecord>(
    `SELECT ${FEEDBACK_SELECT_COLUMNS}
       FROM agent_feedback WHERE agent_id = $1 ORDER BY created_at ASC`,
    [agentId]
  );
  return result.rows;
}

export async function listFeedbackByParent(
  pool: Pool,
  parentAgentId: string
): Promise<FeedbackRecord[]> {
  const result = await pool.query<FeedbackRecord>(
    `SELECT f.id, f.agent_id AS "agentId", f.severity, f.file_path AS "filePath", f.line_number AS "lineNumber",
              f.description, f.suggestion, f.media_ref AS "mediaRef", f.status,
              f.resolution_reason AS "resolutionReason",
              f.resolution_commit AS "resolutionCommit",
              f.resolved_at AS "resolvedAt",
              f.round_number AS "roundNumber",
              f.responds_to_feedback_id AS "respondsToFeedbackId",
              f.created_at AS "createdAt"
       FROM agent_feedback f
       JOIN agents a ON a.id = f.agent_id
       WHERE a.parent_agent_id = $1
       ORDER BY f.created_at ASC`,
    [parentAgentId]
  );
  return result.rows;
}

export async function listFeedbackByParentGrouped(
  pool: Pool,
  parentAgentId: string,
  persona?: string,
  limit = 100
): Promise<{
  personas: Array<{
    persona: string;
    agentId: string;
    feedback: FeedbackRecord[];
  }>;
}> {
  const params: unknown[] = [parentAgentId];
  let whereClause = "WHERE a.parent_agent_id = $1";
  if (persona) {
    params.push(persona);
    whereClause += ` AND a.persona = $${params.length}`;
  }
  params.push(limit);

  const result = await pool.query<FeedbackRecord & { persona: string }>(
    `SELECT f.id, f.agent_id AS "agentId", a.persona, f.severity, f.file_path AS "filePath", f.line_number AS "lineNumber",
              f.description, f.suggestion, f.media_ref AS "mediaRef", f.status,
              f.resolution_reason AS "resolutionReason",
              f.resolution_commit AS "resolutionCommit",
              f.resolved_at AS "resolvedAt",
              f.round_number AS "roundNumber",
              f.responds_to_feedback_id AS "respondsToFeedbackId",
              f.created_at AS "createdAt"
       FROM agent_feedback f
       JOIN agents a ON a.id = f.agent_id
       ${whereClause}
       ORDER BY a.persona, f.created_at ASC
       LIMIT $${params.length}`,
    params
  );

  const grouped = new Map<
    string,
    { persona: string; agentId: string; feedback: FeedbackRecord[] }
  >();
  for (const row of result.rows) {
    const key = row.agentId;
    if (!grouped.has(key)) {
      grouped.set(key, {
        persona: row.persona,
        agentId: row.agentId,
        feedback: [],
      });
    }
    const { persona: _p, ...feedbackRecord } = row;
    grouped.get(key)!.feedback.push(feedbackRecord);
  }

  return { personas: Array.from(grouped.values()) };
}

export async function updateFeedbackStatus(
  pool: Pool,
  feedbackId: number,
  agentId: string,
  status: "open" | "dismissed" | "forwarded" | "fixed" | "ignored",
  options: { reason?: string | null; resolutionCommit?: string | null } = {}
): Promise<FeedbackRecord | null> {
  const reason = options.reason ?? null;
  if (status === "ignored" && !(reason && reason.trim().length > 0)) {
    throw new AgentError(
      "A reason is required when marking feedback as ignored.",
      400
    );
  }
  const result = await pool.query<FeedbackRecord>(
    // resolution_reason / resolution_commit use COALESCE so that a later
    // fixed/ignored call with a null reason (allowed for 'fixed') does not
    // erase the audit-trail captured on the first resolving call.
    // resolved_at is set only on the first transition into fixed/ignored so
    // benign re-calls don't drift the timestamp forward.
    `UPDATE agent_feedback
       SET status = $2,
           resolution_reason = CASE
             WHEN $2 IN ('fixed', 'ignored') THEN COALESCE($4, resolution_reason)
             ELSE resolution_reason
           END,
           resolution_commit = CASE
             WHEN $2 IN ('fixed', 'ignored') THEN COALESCE($5, resolution_commit)
             ELSE resolution_commit
           END,
           resolved_at = CASE
             WHEN $2 IN ('fixed', 'ignored') AND resolved_at IS NULL THEN NOW()
             WHEN $2 NOT IN ('fixed', 'ignored') THEN NULL
             ELSE resolved_at
           END
       WHERE id = $1 AND agent_id = $3
       ${FEEDBACK_RETURNING}`,
    [feedbackId, status, agentId, reason, options.resolutionCommit ?? null]
  );
  return result.rows[0] ?? null;
}

export async function updateFeedbackStatusByParent(
  pool: Pool,
  feedbackId: number,
  parentAgentId: string,
  status: "open" | "dismissed" | "forwarded" | "fixed" | "ignored",
  options: { reason?: string | null; resolutionCommit?: string | null } = {}
): Promise<FeedbackRecord | null> {
  const reason = options.reason ?? null;
  if (status === "ignored" && !(reason && reason.trim().length > 0)) {
    throw new AgentError(
      "A reason is required when marking feedback as ignored.",
      400
    );
  }
  const result = await pool.query<FeedbackRecord>(
    // See updateFeedbackStatus for the COALESCE / first-transition rationale.
    `UPDATE agent_feedback af
       SET status = $2,
           resolution_reason = CASE
             WHEN $2 IN ('fixed', 'ignored') THEN COALESCE($4, af.resolution_reason)
             ELSE af.resolution_reason
           END,
           resolution_commit = CASE
             WHEN $2 IN ('fixed', 'ignored') THEN COALESCE($5, af.resolution_commit)
             ELSE af.resolution_commit
           END,
           resolved_at = CASE
             WHEN $2 IN ('fixed', 'ignored') AND af.resolved_at IS NULL THEN NOW()
             WHEN $2 NOT IN ('fixed', 'ignored') THEN NULL
             ELSE af.resolved_at
           END
       FROM agents a
       WHERE af.id = $1 AND af.agent_id = a.id AND a.parent_agent_id = $3
       RETURNING af.id, af.agent_id AS "agentId", af.severity, af.file_path AS "filePath",
                 af.line_number AS "lineNumber", af.description, af.suggestion,
                 af.media_ref AS "mediaRef", af.status,
                 af.resolution_reason AS "resolutionReason",
                 af.resolution_commit AS "resolutionCommit",
                 af.resolved_at AS "resolvedAt",
                 af.round_number AS "roundNumber",
                 af.responds_to_feedback_id AS "respondsToFeedbackId",
                 af.created_at AS "createdAt"`,
    [
      feedbackId,
      status,
      parentAgentId,
      reason,
      options.resolutionCommit ?? null,
    ]
  );
  return result.rows[0] ?? null;
}

export async function countFeedbackForAgent(
  pool: Pool,
  agentId: string
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM agent_feedback
       WHERE agent_id = $1`,
    [agentId]
  );
  return Number(result.rows[0]?.count ?? "0");
}

export async function listRecentFeedback(
  pool: Pool,
  sinceDays: number
): Promise<Array<FeedbackRecord & { persona: string }>> {
  const result = await pool.query<FeedbackRecord & { persona: string }>(
    `SELECT f.id, f.agent_id AS "agentId", a.persona, f.severity, f.file_path AS "filePath",
              f.line_number AS "lineNumber", f.description, f.suggestion,
              f.media_ref AS "mediaRef", f.status,
              f.resolution_reason AS "resolutionReason",
              f.resolution_commit AS "resolutionCommit",
              f.resolved_at AS "resolvedAt",
              f.round_number AS "roundNumber",
              f.responds_to_feedback_id AS "respondsToFeedbackId",
              f.created_at AS "createdAt"
       FROM agent_feedback f
       JOIN agents a ON a.id = f.agent_id
       WHERE f.created_at >= NOW() - make_interval(days => $1)
       ORDER BY a.persona, f.created_at ASC`,
    [sinceDays]
  );
  return result.rows;
}
