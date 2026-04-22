import type { PoolClient } from "pg";

import { seedNow } from "./constants.js";

// All reviewer children live under the "rich" sidebar agent so the whole
// matrix of review states is visible when it's expanded.
const PARENT = "seed-agent-running-feature";

type Resolution = {
  summary: string;
  resolutionCommit: string | null;
  roundNumber: number;
  minutesAgo: number;
};

type ReviewerSeed = {
  id: string;
  persona: string;
  // When null, no persona_reviews row is created (shows the "no review yet" fallback).
  review: {
    status: "reviewing" | "complete";
    verdict: "approve" | "request_changes" | null;
    message: string | null;
    summary: string | null;
    roundNumber: number;
    minutesAgo: number;
    resolution: Resolution | null;
  } | null;
};

// Covers every UI combination the sidebar can render:
//   · no review yet (CircleDashed)
//   · reviewing in progress (blue spinner)
//   · approved, awaiting response
//   · approved, responded
//   · changes requested, awaiting response (existing demo case)
//   · changes requested, responded (round 1)
//   · changes requested, responded (round 2 — shows R2 badge)
const REVIEWERS: ReviewerSeed[] = [
  {
    id: "seed-review-reviewing",
    persona: "code-quality-review",
    review: {
      status: "reviewing",
      verdict: null,
      message: "Scanning hook dependencies",
      summary: null,
      roundNumber: 1,
      minutesAgo: 1,
      resolution: null,
    },
  },
  {
    id: "seed-review-no-review",
    persona: "backend-security-review",
    review: null,
  },
  {
    id: "seed-review-agent",
    persona: "ux-reviewer",
    review: {
      status: "complete",
      verdict: "request_changes",
      message: null,
      summary:
        "Timezone drift and legend reset need to be resolved before merge. Keyboard focus regression on the day picker is also open.",
      roundNumber: 1,
      minutesAgo: 30,
      resolution: null,
    },
  },
  {
    id: "seed-review-changes-responded",
    persona: "docs-review",
    review: {
      status: "complete",
      verdict: "request_changes",
      message: null,
      summary:
        "Missing JSDoc on the public hooks export and the README example no longer compiles.",
      roundNumber: 1,
      minutesAgo: 90,
      resolution: {
        summary:
          "Added JSDoc on exported hooks and regenerated the README example against the new API.",
        resolutionCommit: "b3f2a1c",
        roundNumber: 1,
        minutesAgo: 20,
      },
    },
  },
  {
    id: "seed-review-changes-responded-r2",
    persona: "architecture-review",
    review: {
      status: "complete",
      verdict: "request_changes",
      message: null,
      summary:
        "Round 2: the retry loop now handles the cache miss, but still bypasses the circuit breaker.",
      roundNumber: 2,
      minutesAgo: 60,
      resolution: {
        summary:
          "Routed retries through the circuit breaker and moved cache warmup behind the same guard.",
        resolutionCommit: "9e7d104",
        roundNumber: 2,
        minutesAgo: 10,
      },
    },
  },
  {
    id: "seed-review-approved-awaiting",
    persona: "perf-review",
    review: {
      status: "complete",
      verdict: "approve",
      message: null,
      summary:
        "No regressions on the hot path; p95 render time unchanged at 12ms.",
      roundNumber: 1,
      minutesAgo: 45,
      resolution: null,
    },
  },
  {
    id: "seed-review-approved-responded",
    persona: "a11y-review",
    review: {
      status: "complete",
      verdict: "approve",
      message: null,
      summary:
        "Focus order and ARIA labels look correct after the latest pass.",
      roundNumber: 1,
      minutesAgo: 120,
      resolution: {
        summary:
          "Confirmed against the NVDA + VoiceOver runbook before merging.",
        resolutionCommit: "4a0c82d",
        roundNumber: 1,
        minutesAgo: 15,
      },
    },
  },
];

export async function seedPersonaReviews(client: PoolClient): Promise<void> {
  const now = seedNow();

  for (const reviewer of REVIEWERS) {
    // Insert the reviewer's child agent row so the FK from persona_reviews is valid.
    await client.query(
      `
      INSERT INTO agents (
        id, name, type, status, cwd, codex_args, full_access, pins,
        persona, parent_agent_id, created_at, updated_at
      ) VALUES ($1,$2,'claude','stopped','/tmp/dispatch-demo','[]'::jsonb,false,'[]'::jsonb,$3,$4, NOW(), NOW())
      `,
      [reviewer.id, `${reviewer.persona} review`, reviewer.persona, PARENT]
    );

    if (!reviewer.review) continue;

    const r = reviewer.review;
    const createdAt = new Date(now.getTime() - r.minutesAgo * 60_000);
    const { rows } = await client.query<{ id: number }>(
      `
      INSERT INTO persona_reviews (
        agent_id, parent_agent_id, persona, status, verdict, message, summary,
        files_reviewed, round_number, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$10)
      RETURNING id
      `,
      [
        reviewer.id,
        PARENT,
        reviewer.persona,
        r.status,
        r.verdict,
        r.message,
        r.summary,
        JSON.stringify([]),
        r.roundNumber,
        createdAt,
      ]
    );

    if (r.resolution) {
      const reviewId = rows[0]?.id;
      if (reviewId == null) continue;
      const submittedAt = new Date(
        now.getTime() - r.resolution.minutesAgo * 60_000
      );
      await client.query(
        `
        INSERT INTO persona_review_resolutions (
          review_id, round_number, summary, resolution_commit, submitted_at
        ) VALUES ($1,$2,$3,$4,$5)
        `,
        [
          reviewId,
          r.resolution.roundNumber,
          r.resolution.summary,
          r.resolution.resolutionCommit,
          submittedAt,
        ]
      );
    }
  }
}
