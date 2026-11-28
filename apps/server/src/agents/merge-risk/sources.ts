/**
 * Evidence sources shared by the live assessor and the offline backfill:
 * review blocks addressed to the agents that own a pull request and the
 * launch briefing. PR details come from the agent's runner
 * (`github-source.ts`). Read-only everywhere.
 */
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { MergeRiskReview } from "./evidence.js";

type ReviewRow = {
  id: string;
  summary: string | null;
  persona: string | null;
  name: string | null;
  blocks: unknown;
};
type FindingRow = {
  author_agent_id: string | null;
  data: Record<string, unknown> | null;
  state: Record<string, unknown> | null;
};

/** Reviews posted to any of the owning agents, oldest first, with findings. */
export async function loadReviewEvidence(
  pool: Pool,
  agentIds: string[],
  options: { settlementProvenance?: boolean } = {}
): Promise<MergeRiskReview[]> {
  if (!agentIds.length) return [];
  const reviews = await pool.query<ReviewRow>(
    `SELECT r.id, r.data->>'summary' AS summary, ag.persona, ag.name, r.state->'blocks' AS blocks
       FROM blocks r LEFT JOIN agents ag ON ag.id = r.author_agent_id
      WHERE r.kind = 'review' AND r.to_agent_id = ANY($1::text[])
      ORDER BY r.created_at, r.id`,
    [agentIds]
  );
  const result: MergeRiskReview[] = [];
  for (const review of reviews.rows) {
    const ids = Array.isArray(review.blocks)
      ? review.blocks.filter((id): id is string => typeof id === "string")
      : [];
    const findings = ids.length
      ? (
          await pool.query<FindingRow>(
            `SELECT data, state, author_agent_id FROM blocks WHERE kind = 'finding' AND id = ANY($1::uuid[]) ORDER BY created_at, id`,
            [ids]
          )
        ).rows
      : [];
    result.push({
      reviewer: review.persona || review.name || "reviewer",
      summary: review.summary ?? "",
      findings: findings.map((f) => {
        const status = f.state?.status;
        const resolution = f.state?.resolution;
        const by = f.state?.by as
          | { kind?: unknown; agentId?: unknown }
          | null
          | undefined;
        const settlementBy =
          by?.kind === "user"
            ? "person"
            : by?.kind === "agent" && typeof by.agentId === "string"
              ? agentIds.includes(by.agentId)
                ? "author"
                : by.agentId === f.author_agent_id
                  ? "reviewer"
                  : "unknown"
              : "unknown";
        return {
          ...(options.settlementProvenance ? { settlementBy } : {}),
          title: String(f.data?.title ?? ""),
          severity: String(f.data?.severity ?? "unknown"),
          status:
            status === "resolved"
              ? resolution === "dismissed"
                ? "dismissed"
                : "fixed"
              : "open",
          ...(typeof f.data?.path === "string" ? { path: f.data.path } : {}),
          ...(typeof f.state?.note === "string" ? { note: f.state.note } : {}),
        };
      }),
    });
  }
  return result;
}

/** The first launch briefing among the owning agents, if any. */
export async function loadBriefing(
  pool: Pool,
  agentIds: string[]
): Promise<string> {
  if (!agentIds.length) return "";
  const row = await pool.query<{ text: string }>(
    `SELECT text FROM blocks WHERE kind = 'launch' AND to_agent_id = ANY($1::text[]) ORDER BY created_at, id LIMIT 1`,
    [agentIds]
  );
  return row.rows[0]?.text ?? "";
}

/** Changes when a review arrives or a finding settles; keyed into records. */
export function reviewFingerprint(reviews: MergeRiskReview[]): string {
  const shape = reviews.map((r) => [
    r.reviewer,
    r.findings.map((f) => f.status),
  ]);
  return createHash("sha256")
    .update(JSON.stringify(shape))
    .digest("hex")
    .slice(0, 16);
}

export function allFindingsResolved(reviews: MergeRiskReview[]): boolean {
  return reviews.every((r) => r.findings.every((f) => f.status !== "open"));
}
