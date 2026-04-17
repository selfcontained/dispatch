import type { PoolClient } from "pg";

import { seedNow } from "./constants.js";

// One persona review attached to the "rich" sidebar agent so the review
// attribution UI has something to render. The reviewer itself is a child
// agent (parent_agent_id points at the sidebar agent) so it stays nested
// rather than showing as a separate top-level entry.
const REVIEW = {
  id: "seed-review-agent",
  parent: "seed-agent-running-feature",
  persona: "ux-reviewer",
  status: "complete" as const,
  verdict: "request_changes" as const,
  summary:
    "Timezone drift and legend reset need to be resolved before merge. Keyboard focus regression on the day picker is also open.",
  minutesAgo: 30,
};

export async function seedPersonaReviews(client: PoolClient): Promise<void> {
  const now = seedNow();
  // Insert the reviewer's child agent row so the FK from persona_reviews is valid.
  await client.query(
    `
    INSERT INTO agents (
      id, name, type, status, cwd, codex_args, full_access, pins,
      persona, parent_agent_id, created_at, updated_at
    ) VALUES ($1,$2,'claude','stopped','/tmp/dispatch-demo','[]'::jsonb,false,'[]'::jsonb,$3,$4, NOW(), NOW())
    `,
    [REVIEW.id, `${REVIEW.persona} review`, REVIEW.persona, REVIEW.parent]
  );

  const createdAt = new Date(now.getTime() - REVIEW.minutesAgo * 60_000);
  await client.query(
    `
    INSERT INTO persona_reviews (
      agent_id, parent_agent_id, persona, status, verdict, summary, files_reviewed,
      created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$8)
    `,
    [
      REVIEW.id,
      REVIEW.parent,
      REVIEW.persona,
      REVIEW.status,
      REVIEW.verdict,
      REVIEW.summary,
      JSON.stringify([]),
      createdAt,
    ]
  );
}
