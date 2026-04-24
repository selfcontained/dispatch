import type { PoolClient } from "pg";

import { seedNow } from "./constants.js";

type FeedbackInput = {
  key: string;
  agentId: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  filePath: string | null;
  lineNumber: number | null;
  description: string;
  suggestion: string | null;
  status: "open" | "fixed" | "dismissed" | "ignored";
  hoursAgo: number;
  roundNumber?: number;
  resolutionReason?: string | null;
  resolutionCommit?: string | null;
  respondsToKey?: string;
};

const ITEMS: FeedbackInput[] = [
  {
    key: "round1-timezone",
    agentId: "seed-review-agent",
    severity: "critical",
    filePath: "apps/server/src/activity-metrics.ts",
    lineNumber: 98,
    description:
      "Timezone drift: aggregation assumes UTC but the UI renders in local time.",
    suggestion:
      "Accept `tz` parameter and bucket on client-local day boundary.",
    status: "open",
    hoursAgo: 4,
    roundNumber: 1,
  },
  {
    key: "round1-legend",
    agentId: "seed-review-agent",
    severity: "high",
    filePath: "apps/web/src/components/activity/ActivityHeatmap.tsx",
    lineNumber: 210,
    description:
      "Legend doesn't update after changing granularity from daily to hourly.",
    suggestion: "Reset legend range on granularity change.",
    status: "open",
    hoursAgo: 5,
    roundNumber: 1,
  },
  {
    key: "awaiting-recheck-parent",
    agentId: "seed-review-awaiting-recheck",
    severity: "medium",
    filePath: "apps/web/src/components/activity/LoadingState.tsx",
    lineNumber: 56,
    description: "Retry spinner never settles after a network timeout.",
    suggestion: "Reuse the shared request lifecycle instead of local timers.",
    status: "fixed",
    hoursAgo: 2,
    roundNumber: 1,
    resolutionReason: "Retry state now comes from the shared request hook.",
    resolutionCommit: "c1a59ef",
  },
  {
    key: "round2-parent",
    agentId: "seed-review-changes-responded-r2",
    severity: "medium",
    filePath: "apps/server/src/cache/retry-loop.ts",
    lineNumber: 44,
    description:
      "The retry loop bypasses the circuit breaker on the cache-miss path.",
    suggestion:
      "Route both warmup and retry traffic through the circuit-breaker helper.",
    status: "fixed",
    hoursAgo: 18,
    roundNumber: 1,
    resolutionReason:
      "Moved retry warmup behind the shared circuit-breaker helper.",
    resolutionCommit: "9e7d104",
  },
  {
    key: "round2-followup",
    agentId: "seed-review-changes-responded-r2",
    severity: "high",
    filePath: "apps/server/src/cache/retry-loop.ts",
    lineNumber: 71,
    description:
      "Round 2: fallback retries still skip the breaker when warmup throws before memoization.",
    suggestion:
      "Guard the fallback branch with the same breaker wrapper used in the primary path.",
    status: "open",
    hoursAgo: 1,
    roundNumber: 2,
    respondsToKey: "round2-parent",
  },
  {
    key: "round2-approved-parent",
    agentId: "seed-review-approved-responded",
    severity: "low",
    filePath: "apps/web/src/components/activity/DayPicker.tsx",
    lineNumber: 22,
    description: "Keyboard focus doesn't return after closing the picker.",
    suggestion:
      "Call `.focus()` on the trigger button in `onOpenChange` after close.",
    status: "fixed",
    hoursAgo: 12,
    roundNumber: 1,
    resolutionReason: "Focus now returns to the trigger on close.",
    resolutionCommit: "4a0c82d",
  },
];

function ago(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

export async function seedFeedback(client: PoolClient): Promise<void> {
  const now = seedNow();
  const idsByKey = new Map<string, number>();

  for (const item of ITEMS) {
    const { rows } = await client.query<{ id: number }>(
      `
      INSERT INTO agent_feedback (
        agent_id, severity, file_path, line_number, description, suggestion,
        status, resolution_reason, resolution_commit, round_number,
        responds_to_feedback_id, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING id
      `,
      [
        item.agentId,
        item.severity,
        item.filePath,
        item.lineNumber,
        item.description,
        item.suggestion,
        item.status,
        item.resolutionReason ?? null,
        item.resolutionCommit ?? null,
        item.roundNumber ?? 1,
        item.respondsToKey ? (idsByKey.get(item.respondsToKey) ?? null) : null,
        ago(now, item.hoursAgo),
      ]
    );
    idsByKey.set(item.key, rows[0]!.id);
  }
}
