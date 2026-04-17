import type { PoolClient } from "pg";

import { seedNow } from "./constants.js";

type FeedbackInput = {
  agentId: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  filePath: string | null;
  lineNumber: number | null;
  description: string;
  suggestion: string | null;
  status: "open" | "fixed" | "dismissed";
  hoursAgo: number;
};

const ITEMS: FeedbackInput[] = [
  {
    agentId: "seed-agent-blocked",
    severity: "high",
    filePath: "apps/web/src/components/FeedbackBadge.tsx",
    lineNumber: 42,
    description:
      "Badge count does not update when feedback is resolved in another tab.",
    suggestion:
      "Subscribe to the SSE `feedback.changed` event to invalidate the query.",
    status: "open",
    hoursAgo: 1,
  },
  {
    agentId: "seed-agent-blocked",
    severity: "medium",
    filePath: "apps/web/src/components/FeedbackSheet.tsx",
    lineNumber: 180,
    description: "Resolved feedback items still appear in the sidebar list.",
    suggestion: "Filter by `status = 'open'` at the query boundary.",
    status: "open",
    hoursAgo: 2,
  },
  {
    agentId: "seed-agent-blocked",
    severity: "low",
    filePath: "apps/web/src/hooks/useFeedback.ts",
    lineNumber: 14,
    description:
      "Stale-while-revalidate window feels too short (2s) causing flicker.",
    suggestion: "Bump to 5s or rely on SSE invalidation only.",
    status: "dismissed",
    hoursAgo: 24,
  },
  {
    agentId: "seed-agent-running-feature",
    severity: "critical",
    filePath: "apps/server/src/activity-metrics.ts",
    lineNumber: 98,
    description:
      "Timezone drift: aggregation assumes UTC but the UI renders in local time.",
    suggestion:
      "Accept `tz` parameter and bucket on client-local day boundary.",
    status: "open",
    hoursAgo: 4,
  },
  {
    agentId: "seed-agent-running-feature",
    severity: "high",
    filePath: "apps/web/src/components/activity/ActivityHeatmap.tsx",
    lineNumber: 210,
    description:
      "Legend doesn't update after changing granularity from daily to hourly.",
    suggestion: "Reset legend range on granularity change.",
    status: "open",
    hoursAgo: 5,
  },
  {
    agentId: "seed-agent-running-feature",
    severity: "medium",
    filePath: "apps/web/src/components/activity/ActivityChart.tsx",
    lineNumber: 56,
    description: "Tooltip hides behind the sidebar on narrow viewports.",
    suggestion: "Portal the tooltip to body.",
    status: "fixed",
    hoursAgo: 18,
  },
  {
    agentId: "seed-agent-running-feature",
    severity: "low",
    filePath: "apps/web/src/components/activity/DayPicker.tsx",
    lineNumber: 22,
    description: "Keyboard focus doesn't return after closing the picker.",
    suggestion:
      "Call `.focus()` on the trigger button in onOpenChange handler.",
    status: "open",
    hoursAgo: 6,
  },
  {
    agentId: "seed-agent-history-1",
    severity: "medium",
    filePath: "apps/web/src/components/layout/Sheet.tsx",
    lineNumber: 77,
    description: "Focus trap swallows Esc when nested dialog is open.",
    suggestion: "Only enable trap for the topmost dialog.",
    status: "fixed",
    hoursAgo: 60,
  },
];

function ago(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

export async function seedFeedback(client: PoolClient): Promise<void> {
  const now = seedNow();
  for (const item of ITEMS) {
    await client.query(
      `
      INSERT INTO agent_feedback (
        agent_id, severity, file_path, line_number,
        description, suggestion, status, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `,
      [
        item.agentId,
        item.severity,
        item.filePath,
        item.lineNumber,
        item.description,
        item.suggestion,
        item.status,
        ago(now, item.hoursAgo),
      ]
    );
  }
}
