import type { PoolClient } from "pg";

import { seedNow } from "./constants.js";

type ReviewInput = {
  agentId: string;
  parentAgentId: string;
  persona: string;
  status: "reviewing" | "complete";
  verdict?: "approve" | "request_changes" | "comment";
  summary?: string;
  minutesAgo: number;
};

// The review "child" agents don't need real records — persona_reviews has
// CASCADE DELETE FKs but we still insert minimal parent+child agent rows
// as reviewer children. We reuse existing seeded agents as parents.
const REVIEW_CHILDREN = [
  {
    id: "seed-review-agent-1",
    parent: "seed-agent-blocked",
    persona: "ux-reviewer",
    status: "complete" as const,
    verdict: "request_changes" as const,
    summary:
      "Badge count and stale sidebar entries need to be fixed before merge.",
    minutesAgo: 15,
  },
  {
    id: "seed-review-agent-2",
    parent: "seed-agent-running-feature",
    persona: "security-reviewer",
    status: "reviewing" as const,
    minutesAgo: 4,
  },
  {
    id: "seed-review-agent-3",
    parent: "seed-agent-history-1",
    persona: "ux-reviewer",
    status: "complete" as const,
    verdict: "approve" as const,
    summary:
      "Migration to shadcn Sheet is clean; focus trap regression resolved.",
    minutesAgo: 60 * 48,
  },
];

export async function seedPersonaReviews(client: PoolClient): Promise<void> {
  const now = seedNow();
  for (const review of REVIEW_CHILDREN) {
    // Insert a minimal child agent row that this review is attached to.
    await client.query(
      `
      INSERT INTO agents (
        id, name, type, status, cwd, codex_args, full_access, pins,
        persona, parent_agent_id, created_at, updated_at
      ) VALUES ($1,$2,'claude','stopped','/tmp/dispatch-demo','[]'::jsonb,false,'[]'::jsonb,$3,$4, NOW(), NOW())
      `,
      [review.id, `${review.persona} review`, review.persona, review.parent]
    );

    const input: ReviewInput = {
      agentId: review.id,
      parentAgentId: review.parent,
      persona: review.persona,
      status: review.status,
      verdict: review.verdict,
      summary: review.summary,
      minutesAgo: review.minutesAgo,
    };
    const createdAt = new Date(now.getTime() - input.minutesAgo * 60_000);
    await client.query(
      `
      INSERT INTO persona_reviews (
        agent_id, parent_agent_id, persona, status, verdict, summary, files_reviewed,
        created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$8)
      `,
      [
        input.agentId,
        input.parentAgentId,
        input.persona,
        input.status,
        input.verdict ?? null,
        input.summary ?? null,
        JSON.stringify([]),
        createdAt,
      ]
    );
  }
}
