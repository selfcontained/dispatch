import type { PoolClient } from "pg";

import { seedNow } from "./constants.js";

const AGENT_ID = "seed-agent-running-feature";

type ThreadMsg = {
  authorType: "human" | "agent";
  body: string;
  minutesAgo: number;
};

type FeedbackSeed = {
  filePath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  diffSnapshot: string | null;
  status: "open" | "resolved";
  resolution: string | null;
  resolutionNote: string | null;
  messages: ThreadMsg[];
};

type ReviewSeed = {
  summary: string;
  status: "open" | "resolved" | "partially_resolved";
  minutesAgo: number;
  items: FeedbackSeed[];
};

const REVIEWS: ReviewSeed[] = [
  {
    summary:
      "Several issues with the heatmap rendering — timezone handling, color scale, and an accessibility gap on the legend toggle.",
    status: "partially_resolved",
    minutesAgo: 90,
    items: [
      {
        filePath: "apps/web/src/components/heatmap/HeatmapGrid.tsx",
        lineStart: 42,
        lineEnd: 58,
        diffSnapshot: [
          "@@ -42,8 +42,12 @@",
          "-  const hours = Array.from({ length: 24 }, (_, i) => i);",
          "+  const hours = useMemo(",
          "+    () => Array.from({ length: 24 }, (_, i) => i),",
          "+    []",
          "+  );",
        ].join("\n"),
        status: "resolved",
        resolution: "fixed",
        resolutionNote:
          "Wrapped in useMemo and shifted to UTC-based hour bucketing.",
        messages: [
          {
            authorType: "human",
            body: "The hour array is recreated every render. Also, the bucketing uses local time instead of UTC — so the heatmap shifts depending on the viewer's timezone.",
            minutesAgo: 88,
          },
          {
            authorType: "agent",
            body: "Good catch. I've memoized the array and switched to `getUTCHours()` for bucketing. The tooltip now shows the UTC offset so the user knows what they're looking at.",
            minutesAgo: 45,
          },
        ],
      },
      {
        filePath: "apps/web/src/components/heatmap/ColorScale.tsx",
        lineStart: 15,
        lineEnd: 22,
        diffSnapshot: [
          "@@ -15,5 +15,8 @@",
          "-  const scale = scaleLinear([0, max], ['#ebedf0', '#216e39']);",
          "+  const scale = scaleLinear(",
          "+    [0, max],",
          "+    ['var(--heatmap-empty)', 'var(--heatmap-full)']",
          "+  );",
        ].join("\n"),
        status: "open",
        resolution: null,
        resolutionNote: null,
        messages: [
          {
            authorType: "human",
            body: "Hard-coded hex colors won't work in dark mode. Use CSS custom properties so the palette flips with the theme.",
            minutesAgo: 87,
          },
          {
            authorType: "agent",
            body: "I can swap the hex values for CSS custom properties. Should I define them in the global stylesheet or scope them to the heatmap component?",
            minutesAgo: 60,
          },
          {
            authorType: "human",
            body: "Global stylesheet — they should be part of the theme so other components can reuse the same palette tokens.",
            minutesAgo: 55,
          },
          {
            authorType: "agent",
            body: "Makes sense. I'll add `--heatmap-empty` and `--heatmap-full` to the theme's CSS variables and reference them here. Working on it now.",
            minutesAgo: 50,
          },
          {
            authorType: "human",
            body: "Perfect — also add a mid-range variable `--heatmap-mid` so the 3-stop gradient looks right in both themes.",
            minutesAgo: 30,
          },
        ],
      },
      {
        filePath: "apps/web/src/components/heatmap/Legend.tsx",
        lineStart: 8,
        lineEnd: 14,
        diffSnapshot: null,
        status: "resolved",
        resolution: "fixed",
        resolutionNote:
          "Added aria-label and keyboard toggle with Enter/Space.",
        messages: [
          {
            authorType: "human",
            body: "The legend toggle has no aria-label and can't be activated with the keyboard. This will fail an a11y audit.",
            minutesAgo: 86,
          },
          {
            authorType: "agent",
            body: 'Fixed — the toggle now has `aria-label="Toggle legend"` and responds to Enter and Space key events.',
            minutesAgo: 40,
          },
        ],
      },
    ],
  },
  {
    summary: "API endpoint review — rate limiting and response shape.",
    status: "resolved",
    minutesAgo: 180,
    items: [
      {
        filePath: "apps/server/src/routes/heatmap.ts",
        lineStart: 34,
        lineEnd: 41,
        diffSnapshot: [
          "@@ -34,6 +34,8 @@",
          "+  if (!req.session?.userId) {",
          "+    return reply.code(401).send({ error: 'unauthorized' });",
          "+  }",
        ].join("\n"),
        status: "resolved",
        resolution: "fixed",
        resolutionNote: "Added auth guard and rate limiter middleware.",
        messages: [
          {
            authorType: "human",
            body: "This endpoint is unauthenticated and has no rate limiting. It should require a session and apply the standard rate limiter.",
            minutesAgo: 178,
          },
          {
            authorType: "agent",
            body: "Added the `requireAuth` guard and wired in `rateLimiter({ max: 30, window: '1m' })`. Also normalized the error response to use the standard `{ error }` shape.",
            minutesAgo: 150,
          },
        ],
      },
      {
        filePath: "apps/server/src/routes/heatmap.ts",
        lineStart: 55,
        lineEnd: 60,
        diffSnapshot: null,
        status: "resolved",
        resolution: "dismissed",
        resolutionNote:
          "Response shape matches the existing pattern used by other endpoints — changing it would be a breaking change.",
        messages: [
          {
            authorType: "human",
            body: "The response wraps data in `{ result: ... }` instead of `{ data: ... }`. Is this intentional?",
            minutesAgo: 176,
          },
          {
            authorType: "agent",
            body: "This matches the existing `{ result }` pattern used by the activity and token-usage endpoints. Changing it here would break clients and diverge from the convention.",
            minutesAgo: 148,
          },
        ],
      },
    ],
  },
];

export async function seedReviews(client: PoolClient): Promise<void> {
  const now = seedNow();

  for (const review of REVIEWS) {
    const createdAt = new Date(now.getTime() - review.minutesAgo * 60_000);

    const { rows } = await client.query<{ id: number }>(
      `
      INSERT INTO reviews (
        agent_id, assigned_agent_id, reviewer_type, reviewer_agent_id,
        summary, status, base_ref, created_at, updated_at
      ) VALUES ($1, $1, 'human', NULL, $2, $3, 'main', $4, $4)
      RETURNING id
      `,
      [AGENT_ID, review.summary, review.status, createdAt]
    );

    const reviewId = rows[0]?.id;
    if (reviewId == null) continue;

    for (const item of review.items) {
      const resolvedAt =
        item.status === "resolved"
          ? new Date(now.getTime() - 30 * 60_000)
          : null;

      const { rows: itemRows } = await client.query<{ id: number }>(
        `
        INSERT INTO review_feedback_items (
          review_id, file_path, line_start, line_end, diff_snapshot, base_ref,
          status, resolution, resolution_note, resolved_by, resolved_at,
          created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,'main',$6,$7,$8,$9,$10,$11,$11)
        RETURNING id
        `,
        [
          reviewId,
          item.filePath,
          item.lineStart,
          item.lineEnd,
          item.diffSnapshot,
          item.status,
          item.resolution,
          item.resolutionNote,
          item.status === "resolved" ? AGENT_ID : null,
          resolvedAt,
          createdAt,
        ]
      );

      const feedbackItemId = itemRows[0]?.id;
      if (feedbackItemId == null) continue;

      for (const msg of item.messages) {
        const msgCreatedAt = new Date(now.getTime() - msg.minutesAgo * 60_000);
        await client.query(
          `
          INSERT INTO review_thread_messages (
            feedback_item_id, author_type, author_agent_id, type, content, created_at
          ) VALUES ($1,$2,$3,'text',$4,$5)
          `,
          [
            feedbackItemId,
            msg.authorType,
            msg.authorType === "agent" ? AGENT_ID : null,
            JSON.stringify({ body: msg.body }),
            msgCreatedAt,
          ]
        );
      }
    }
  }
}
