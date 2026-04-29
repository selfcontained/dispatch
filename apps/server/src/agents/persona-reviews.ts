import type { Pool } from "pg";

import { AgentError } from "./errors.js";

export type PersonaReviewRecord = {
  id: number;
  agentId: string;
  parentAgentId: string;
  persona: string;
  status: string;
  message: string | null;
  verdict: string | null;
  summary: string | null;
  filesReviewed: string[] | null;
  lastReviewedCommit: string | null;
  roundNumber: number;
  allowRecheck: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PersonaReviewResolutionRecord = {
  id: number;
  reviewId: number;
  roundNumber: number;
  summary: string;
  resolutionCommit: string | null;
  submittedAt: string;
};

export type PersonaReviewResolutionItem = {
  feedbackId: number;
  originalDescription: string;
  originalSeverity: string;
  status: string;
  reason: string | null;
  filePath: string | null;
  lineNumber: number | null;
  suggestion: string | null;
  resolutionCommit: string | null;
  resolvedAt: string | null;
  roundNumber: number;
};

export type ReviewerRecheckContext = {
  review: PersonaReviewRecord;
  resolution: PersonaReviewResolutionRecord;
  resolutions: PersonaReviewResolutionItem[];
};

const PERSONA_REVIEW_SELECT = `
  SELECT id, agent_id AS "agentId", parent_agent_id AS "parentAgentId",
         persona, status, message, verdict, summary,
         files_reviewed AS "filesReviewed",
         last_reviewed_commit AS "lastReviewedCommit",
         round_number AS "roundNumber",
         allow_recheck AS "allowRecheck",
         created_at AS "createdAt", updated_at AS "updatedAt"
  FROM persona_reviews
`;

const PERSONA_REVIEW_RETURNING = `
  RETURNING id, agent_id AS "agentId", parent_agent_id AS "parentAgentId",
            persona, status, message, verdict, summary,
            files_reviewed AS "filesReviewed",
            last_reviewed_commit AS "lastReviewedCommit",
            round_number AS "roundNumber",
            allow_recheck AS "allowRecheck",
            created_at AS "createdAt", updated_at AS "updatedAt"
`;

/**
 * Input validator for `review_status` pings. Today only `"reviewing"` is
 * valid; extracted as a pure helper so tests can assert the accept/reject
 * behaviour without touching the database.
 */
export function resolveProgressPingStatus(requested: string): "reviewing" {
  if (requested !== "reviewing") {
    throw new AgentError(
      `Invalid review status "${requested}". Must be one of: reviewing`,
      400
    );
  }
  return "reviewing";
}

export async function createPersonaReview(
  pool: Pool,
  input: {
    agentId: string;
    parentAgentId: string;
    persona: string;
    lastReviewedCommit?: string | null;
    allowRecheck?: boolean;
  }
): Promise<PersonaReviewRecord> {
  const result = await pool.query<PersonaReviewRecord>(
    `INSERT INTO persona_reviews (agent_id, parent_agent_id, persona, last_reviewed_commit, allow_recheck)
     VALUES ($1, $2, $3, $4, COALESCE($5, false))
     ${PERSONA_REVIEW_RETURNING}`,
    [
      input.agentId,
      input.parentAgentId,
      input.persona,
      input.lastReviewedCommit ?? null,
      input.allowRecheck ?? null,
    ]
  );
  return result.rows[0]!;
}

export async function updatePersonaReviewStatus(
  pool: Pool,
  agentId: string,
  input: { status: string; message?: string }
): Promise<PersonaReviewRecord> {
  // review_status is a progress-ping channel only. It must not transition
  // the review *out of* a non-working state — in particular, it must not
  // clobber `awaiting_recheck` (reviewer is doing round 2) back to
  // `reviewing` (that tricks completePersonaReview into thinking the next
  // close is round 1 again). Terminal states are also off-limits. Compute
  // the effective next status in code — easier to unit-test and lets us
  // surface a specific error for the terminal cases.
  const nextStatus = resolveProgressPingStatus(input.status);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query<{ status: string }>(
      `SELECT status FROM persona_reviews WHERE agent_id = $1 FOR UPDATE`,
      [agentId]
    );
    const current = currentResult.rows[0];
    if (!current) {
      throw new AgentError("No persona review found for agent.", 404);
    }
    if (current.status === "complete" || current.status === "cancelled") {
      throw new AgentError(
        `Cannot ping review_status on a ${current.status} review. Progress pings are only accepted while the review is active.`,
        409
      );
    }

    // awaiting_recheck is "active" from the reviewer's perspective — they
    // are doing round 2 — so accept the ping but preserve the status label.
    const statusToPersist =
      current.status === "awaiting_recheck" ? current.status : nextStatus;

    const result = await client.query<PersonaReviewRecord>(
      `UPDATE persona_reviews
         SET status = $2, message = $3, updated_at = NOW()
         WHERE agent_id = $1
         ${PERSONA_REVIEW_RETURNING}`,
      [agentId, statusToPersist, input.message ?? null]
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

export async function completePersonaReview(
  pool: Pool,
  agentId: string,
  input: {
    verdict: string;
    summary: string;
    filesReviewed?: string[];
    message?: string;
    lastReviewedCommit?: string | null;
  }
): Promise<PersonaReviewRecord> {
  const VALID_VERDICTS = ["approve", "request_changes"];
  if (!VALID_VERDICTS.includes(input.verdict)) {
    throw new AgentError(
      `verdict must be one of: ${VALID_VERDICTS.join(", ")}`,
      400
    );
  }
  if (input.summary.length > 10_000) {
    throw new AgentError("summary exceeds 10,000 character limit.", 400);
  }
  if (input.message && input.message.length > 5_000) {
    throw new AgentError("message exceeds 5,000 character limit.", 400);
  }
  if (input.filesReviewed) {
    if (input.filesReviewed.length > 500) {
      throw new AgentError("filesReviewed exceeds 500 item limit.", 400);
    }
    for (const filePath of input.filesReviewed) {
      if (filePath.length > 500) {
        throw new AgentError(
          "Individual file path in filesReviewed exceeds 500 character limit.",
          400
        );
      }
    }
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const currentResult = await client.query<PersonaReviewRecord>(
      `${PERSONA_REVIEW_SELECT}
         WHERE agent_id = $1
         FOR UPDATE`,
      [agentId]
    );
    const current = currentResult.rows[0];
    if (!current) {
      throw new AgentError("No persona review found for agent.", 404);
    }

    let nextRoundNumber = current.roundNumber;
    if (current.status === "reviewing") {
      // Normally 'reviewing' means round 1. But defense-in-depth:
      // if there's already a submitted resolution for this review,
      // the next close belongs to the round after the resolution, no
      // matter how we ended up back in 'reviewing'. This guards
      // against any future path that could downgrade the status
      // field while a round-trip is in flight.
      const priorResolution = await client.query<{ roundNumber: number }>(
        `SELECT round_number AS "roundNumber"
           FROM persona_review_resolutions
           WHERE review_id = $1
           ORDER BY round_number DESC
           LIMIT 1`,
        [current.id]
      );
      const resolvedRound = priorResolution.rows[0]?.roundNumber ?? 0;
      nextRoundNumber = resolvedRound > 0 ? resolvedRound + 1 : 1;
      if (nextRoundNumber > 2) {
        throw new AgentError(
          "Round 2 already complete. This review only supports a single round-trip.",
          409
        );
      }
    } else if (current.status === "awaiting_recheck") {
      if (current.roundNumber >= 2) {
        throw new AgentError(
          "Round 2 already complete. This review only supports a single round-trip.",
          409
        );
      }
      nextRoundNumber = current.roundNumber + 1;
    } else if (current.status === "complete" && current.roundNumber >= 2) {
      throw new AgentError(
        "Round 2 already complete. This review only supports a single round-trip.",
        409
      );
    } else {
      throw new AgentError(
        `Review can only be completed from 'reviewing' or 'awaiting_recheck' (current: ${current.status}).`,
        409
      );
    }

    const result = await client.query<PersonaReviewRecord>(
      `UPDATE persona_reviews
         SET status = 'complete', verdict = $2, summary = $3,
             files_reviewed = $4::jsonb, message = $5,
             last_reviewed_commit = COALESCE($6, last_reviewed_commit),
             round_number = $7,
             updated_at = NOW()
         WHERE agent_id = $1
         ${PERSONA_REVIEW_RETURNING}`,
      [
        agentId,
        input.verdict,
        input.summary,
        JSON.stringify(input.filesReviewed ?? []),
        input.message ?? null,
        input.lastReviewedCommit ?? null,
        nextRoundNumber,
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

export async function getPersonaReview(
  pool: Pool,
  agentId: string
): Promise<PersonaReviewRecord | null> {
  const result = await pool.query<PersonaReviewRecord>(
    `${PERSONA_REVIEW_SELECT} WHERE agent_id = $1`,
    [agentId]
  );
  return result.rows[0] ?? null;
}

export async function getPersonaReviewsByParent(
  pool: Pool,
  parentAgentId: string
): Promise<PersonaReviewRecord[]> {
  const result = await pool.query<PersonaReviewRecord>(
    `${PERSONA_REVIEW_SELECT}
       WHERE parent_agent_id = $1
       ORDER BY created_at`,
    [parentAgentId]
  );
  return result.rows;
}

export async function listRecentPersonaReviews(
  pool: Pool,
  sinceDays: number
): Promise<PersonaReviewRecord[]> {
  const result = await pool.query<PersonaReviewRecord>(
    `${PERSONA_REVIEW_SELECT}
       WHERE created_at >= NOW() - make_interval(days => $1)
       ORDER BY created_at`,
    [sinceDays]
  );
  return result.rows;
}

export async function submitReviewResolution(
  pool: Pool,
  input: {
    parentAgentId: string;
    personaAgentId: string;
    summary: string;
    resolutionCommit?: string | null;
  }
): Promise<{
  review: PersonaReviewRecord;
  resolution: PersonaReviewResolutionRecord;
}> {
  const summary = input.summary.trim();
  if (summary.length === 0) {
    throw new AgentError("summary is required.", 400);
  }
  if (summary.length > 10_000) {
    throw new AgentError("summary exceeds 10,000 character limit.", 400);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const reviewResult = await client.query<PersonaReviewRecord>(
      `${PERSONA_REVIEW_SELECT}
         WHERE agent_id = $1 AND parent_agent_id = $2
         FOR UPDATE`,
      [input.personaAgentId, input.parentAgentId]
    );
    const review = reviewResult.rows[0];
    if (!review) {
      throw new AgentError(
        `No persona review found for agent ${input.personaAgentId} under parent ${input.parentAgentId}.`,
        404
      );
    }
    if (review.status === "awaiting_recheck") {
      throw new AgentError(
        "Review is already awaiting recheck; dispatch_submit_resolution cannot be called again in that state.",
        409
      );
    }
    if (review.status === "complete" && review.roundNumber >= 2) {
      throw new AgentError(
        "Round 2 already complete. This review only supports a single round-trip.",
        409
      );
    }
    if (review.status !== "complete") {
      throw new AgentError(
        `Review must be in status 'complete' to submit a resolution (current: ${review.status}).`,
        409
      );
    }

    const openOrUnresolved = await client.query<{
      id: number;
      status: string;
      resolution_reason: string | null;
    }>(
      `SELECT id, status, resolution_reason
         FROM agent_feedback
         WHERE agent_id = $1
         ORDER BY id ASC`,
      [input.personaAgentId]
    );
    const openIds: number[] = [];
    const ignoredMissingReason: number[] = [];
    for (const row of openOrUnresolved.rows) {
      if (row.status === "open") {
        openIds.push(row.id);
      } else if (
        row.status === "ignored" &&
        !(row.resolution_reason && row.resolution_reason.trim().length > 0)
      ) {
        ignoredMissingReason.push(row.id);
      }
    }
    if (openIds.length > 0) {
      throw new AgentError(
        `Cannot submit resolution — feedback items still open: ${openIds.join(", ")}. Call dispatch_resolve_feedback on each with status 'fixed' or 'ignored' (include a reason for any you ignore), then try again.`,
        409
      );
    }
    if (ignoredMissingReason.length > 0) {
      throw new AgentError(
        `Cannot submit resolution — ignored feedback items missing a reason: ${ignoredMissingReason.join(", ")}. Call dispatch_resolve_feedback again on each with status 'ignored' and a reason explaining why it was not addressed, then try again.`,
        409
      );
    }

    const roundNumber = review.roundNumber;
    const inserted = await client.query<PersonaReviewResolutionRecord>(
      `INSERT INTO persona_review_resolutions
           (review_id, round_number, summary, resolution_commit)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (review_id, round_number) DO UPDATE
           SET summary = EXCLUDED.summary,
               resolution_commit = EXCLUDED.resolution_commit,
               submitted_at = NOW()
         RETURNING id,
                   review_id AS "reviewId",
                   round_number AS "roundNumber",
                   summary,
                   resolution_commit AS "resolutionCommit",
                   submitted_at AS "submittedAt"`,
      [review.id, roundNumber, summary, input.resolutionCommit ?? null]
    );

    const nextStatus = review.allowRecheck ? "awaiting_recheck" : "complete";
    const updatedReviewResult = await client.query<PersonaReviewRecord>(
      `UPDATE persona_reviews
         SET status = $2, updated_at = NOW()
         WHERE id = $1
         ${PERSONA_REVIEW_RETURNING}`,
      [review.id, nextStatus]
    );

    await client.query("COMMIT");
    return {
      review: updatedReviewResult.rows[0]!,
      resolution: inserted.rows[0]!,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getReviewResolutions(
  pool: Pool,
  reviewId: number
): Promise<PersonaReviewResolutionRecord[]> {
  const result = await pool.query<PersonaReviewResolutionRecord>(
    `SELECT id, review_id AS "reviewId", round_number AS "roundNumber",
              summary, resolution_commit AS "resolutionCommit",
              submitted_at AS "submittedAt"
       FROM persona_review_resolutions
       WHERE review_id = $1
       ORDER BY round_number ASC, submitted_at ASC`,
    [reviewId]
  );
  return result.rows;
}

export async function listResolvedFeedbackForRound(
  pool: Pool,
  personaAgentId: string,
  roundNumber: number
): Promise<PersonaReviewResolutionItem[]> {
  const result = await pool.query<PersonaReviewResolutionItem>(
    `SELECT id AS "feedbackId",
              description AS "originalDescription",
              severity AS "originalSeverity",
              status,
              resolution_reason AS reason,
              file_path AS "filePath",
              line_number AS "lineNumber",
              suggestion,
              resolution_commit AS "resolutionCommit",
              resolved_at AS "resolvedAt",
              round_number AS "roundNumber"
       FROM agent_feedback
       WHERE agent_id = $1 AND round_number = $2
       ORDER BY id ASC`,
    [personaAgentId, roundNumber]
  );
  return result.rows;
}

export async function getReviewerRecheckContext(
  pool: Pool,
  agentId: string
): Promise<ReviewerRecheckContext | null> {
  const review = await getPersonaReview(pool, agentId);
  if (!review) {
    return null;
  }

  const resolution = (await getReviewResolutions(pool, review.id)).at(-1);
  if (!resolution) {
    return null;
  }

  return {
    review,
    resolution,
    resolutions: await listResolvedFeedbackForRound(
      pool,
      agentId,
      resolution.roundNumber
    ),
  };
}

export async function cancelReviewRecheck(
  pool: Pool,
  input: {
    parentAgentId: string;
    personaAgentId: string;
    reason?: string | null;
  }
): Promise<{ review: PersonaReviewRecord; transitioned: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const reviewResult = await client.query<PersonaReviewRecord>(
      `${PERSONA_REVIEW_SELECT}
         WHERE agent_id = $1 AND parent_agent_id = $2
         FOR UPDATE`,
      [input.personaAgentId, input.parentAgentId]
    );
    const review = reviewResult.rows[0];
    if (!review) {
      throw new AgentError(
        `No persona review found for agent ${input.personaAgentId} under parent ${input.parentAgentId}.`,
        404
      );
    }
    if (review.status === "complete" && review.roundNumber >= 2) {
      throw new AgentError(
        "Cannot cancel recheck after round 2 is already complete.",
        409
      );
    }
    if (review.status === "cancelled") {
      await client.query("COMMIT");
      return { review, transitioned: false };
    }
    if (
      review.status !== "awaiting_recheck" &&
      !(review.status === "complete" && review.allowRecheck)
    ) {
      throw new AgentError(
        `Recheck can only be cancelled while awaiting round 2 or while the reviewer is polling after round 1 (current: ${review.status}).`,
        409
      );
    }

    const updatedResult = await client.query<PersonaReviewRecord>(
      `UPDATE persona_reviews
         SET status = 'cancelled',
             message = COALESCE($2, message),
             updated_at = NOW()
         WHERE id = $1
         ${PERSONA_REVIEW_RETURNING}`,
      [review.id, input.reason ?? null]
    );

    await client.query("COMMIT");
    return { review: updatedResult.rows[0]!, transitioned: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
