import type { PoolClient } from "pg";

import { mulberry32, seedMetadata, seedNow } from "./constants.js";

type EventRow = {
  agent_id: string;
  event_type: "working" | "blocked" | "waiting_user" | "done";
  message: string;
  metadata: string;
  created_at: Date;
  agent_type: string;
  agent_name: string;
  project_dir: string;
};

/**
 * ~150 days of synthetic activity across three projects so the Activity page
 * has heatmap + chart data to render. Deterministic via mulberry32.
 * Mirrors the pattern from e2e/helpers.ts but scoped to what a dev instance
 * needs — not the full 420-day stress test.
 */
function buildRows(now: Date): EventRow[] {
  const projects = [
    { dir: "/tmp/dispatch-demo", agentType: "codex" },
    { dir: "/tmp/ios-client-demo", agentType: "claude" },
    { dir: "/tmp/marketing-site-demo", agentType: "opencode" },
  ];
  const dayCount = 150;
  const rows: EventRow[] = [];
  const start = new Date(now.getTime() - dayCount * 24 * 60 * 60 * 1000);

  for (let dayOffset = 0; dayOffset < dayCount; dayOffset += 1) {
    const day = new Date(start.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const weekday = day.getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    const projectIndex = weekend ? dayOffset % 2 : dayOffset % projects.length;
    const project = projects[projectIndex];
    const random = mulberry32(dayOffset * 97 + projectIndex * 131 + 17);

    const activeAgents = weekend
      ? random() > 0.6
        ? 1
        : 0
      : random() > 0.85
        ? 3
        : 2;

    for (let agentIndex = 0; agentIndex < activeAgents; agentIndex += 1) {
      const startHour = weekend
        ? 9 + Math.floor(random() * 6)
        : 8 + Math.floor(random() * 3) + (agentIndex === 2 ? 1 : 0);
      const startMinute = Math.floor(random() * 40);
      const workingBlockMinutes = weekend
        ? 70 + Math.floor(random() * 80)
        : 105 + Math.floor(random() * 85);
      const blockedMinutes =
        random() > (weekend ? 0.78 : 0.55) ? 0 : 10 + Math.floor(random() * 35);
      const waitingMinutes =
        random() > (weekend ? 0.88 : 0.68) ? 0 : 8 + Math.floor(random() * 28);
      const reviewBlockMinutes = weekend
        ? 20 + Math.floor(random() * 40)
        : 45 + Math.floor(random() * 55);
      const agentId = `seed-history-${projectIndex}-${agentIndex}`;
      const agentName = weekend
        ? `Weekend ${agentIndex + 1}`
        : `Builder ${projectIndex + 1}-${agentIndex + 1}`;

      const workingAt = new Date(
        Date.UTC(
          day.getUTCFullYear(),
          day.getUTCMonth(),
          day.getUTCDate(),
          startHour,
          startMinute
        )
      );
      rows.push({
        agent_id: agentId,
        event_type: "working",
        message: "Deep work block",
        metadata: seedMetadata({ phase: "working" }),
        created_at: workingAt,
        agent_type: project.agentType,
        agent_name: agentName,
        project_dir: project.dir,
      });

      let cursor = new Date(
        workingAt.getTime() + workingBlockMinutes * 60 * 1000
      );
      if (blockedMinutes > 0) {
        rows.push({
          agent_id: agentId,
          event_type: "blocked",
          message: "Waiting on review feedback",
          metadata: seedMetadata({ phase: "blocked" }),
          created_at: cursor,
          agent_type: project.agentType,
          agent_name: agentName,
          project_dir: project.dir,
        });
        cursor = new Date(cursor.getTime() + blockedMinutes * 60 * 1000);
      }
      if (waitingMinutes > 0) {
        rows.push({
          agent_id: agentId,
          event_type: "waiting_user",
          message: "Need a product call",
          metadata: seedMetadata({ phase: "waiting" }),
          created_at: cursor,
          agent_type: project.agentType,
          agent_name: agentName,
          project_dir: project.dir,
        });
        cursor = new Date(cursor.getTime() + waitingMinutes * 60 * 1000);
      }

      rows.push({
        agent_id: agentId,
        event_type: "working",
        message: "Afternoon execution",
        metadata: seedMetadata({ phase: "wrap-up" }),
        created_at: cursor,
        agent_type: project.agentType,
        agent_name: agentName,
        project_dir: project.dir,
      });
      cursor = new Date(cursor.getTime() + reviewBlockMinutes * 60 * 1000);
      rows.push({
        agent_id: agentId,
        event_type: "done",
        message: "Shipped for the day",
        metadata: seedMetadata({ phase: "done" }),
        created_at: cursor,
        agent_type: project.agentType,
        agent_name: agentName,
        project_dir: project.dir,
      });
    }
  }

  return rows.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
}

export async function seedActivityEvents(client: PoolClient): Promise<void> {
  const rows = buildRows(seedNow());
  const insertSql = `INSERT INTO agent_events
    (agent_id, event_type, message, metadata, created_at, agent_type, agent_name, project_dir)
    VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)`;
  for (const row of rows) {
    await client.query(insertSql, [
      row.agent_id,
      row.event_type,
      row.message,
      row.metadata,
      row.created_at,
      row.agent_type,
      row.agent_name,
      row.project_dir,
    ]);
  }
}
