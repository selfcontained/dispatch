import path from "node:path";

import type { Pool } from "pg";

import { resolveConfiguredPath } from "../shared/lib/resolve-tilde.js";
import type { AgentGitContext } from "./types.js";

export type FeedbackSummaryResult = {
  period: { start: string; end: string };
  totalFindings: number;
  bySeverity: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
  byStatus: {
    open: number;
    fixed: number;
    ignored: number;
    dismissed: number;
  };
  groups: Array<{
    key: string;
    count: number;
    /** Distinct finding descriptions in the group — not the length of topFindings, which is capped. */
    distinctFindings: number;
    bySeverity: {
      critical: number;
      high: number;
      medium: number;
      low: number;
      info: number;
    };
    topFindings: Array<{
      description: string;
      count: number;
      severity: string;
      exampleFilePath: string | null;
    }>;
  }>;
  reviewVerdicts: {
    total: number;
    approved: number;
    changesRequested: number;
  };
};

export async function getFeedbackSummary(
  pool: Pool,
  params: {
    start: Date;
    end: Date;
    project?: string;
    groupBy: "persona" | "severity" | "directory";
  }
): Promise<FeedbackSummaryResult> {
  const rangeStart = params.start;
  const rangeEnd = params.end;

  const feedbackConditions = ["b.created_at >= $1", "b.created_at <= $2"];
  const feedbackParams: unknown[] = [rangeStart, rangeEnd];
  if (params.project) {
    feedbackParams.push(params.project);
    feedbackConditions.push(
      `COALESCE(pa.git_context->>'repoRoot', pa.cwd) = $${feedbackParams.length}`
    );
  }

  const verdictConditions = ["b.created_at >= $1", "b.created_at <= $2"];
  const verdictParams: unknown[] = [rangeStart, rangeEnd];
  if (params.project) {
    verdictParams.push(params.project);
    verdictConditions.push(
      `COALESCE(pa.git_context->>'repoRoot', pa.cwd) = $${verdictParams.length}`
    );
  }

  // Fetch feedback rows and verdict aggregates in parallel
  const [feedbackResult, verdictResult] = await Promise.all([
    pool.query<{
      persona: string;
      severity: string;
      description: string;
      filePath: string | null;
      status: string;
      projectRoot: string;
    }>(
      `SELECT COALESCE(ra.persona, ra.name, 'you') AS persona,
                CASE b.data->>'severity'
                  WHEN 'blocker' THEN 'critical'
                  WHEN 'major' THEN 'high'
                  WHEN 'minor' THEN 'medium'
                  WHEN 'nit' THEN 'low'
                  ELSE 'info'
                END AS severity,
                COALESCE(b.data->>'title', '') AS description,
                b.data->>'path' AS "filePath",
                CASE
                  WHEN b.state->>'status' = 'resolved'
                  THEN COALESCE(b.state->>'resolution', 'fixed')
                  ELSE 'open'
                END AS status,
                COALESCE(pa.git_context->>'repoRoot', pa.cwd) AS "projectRoot"
         FROM blocks b
         JOIN agents pa ON pa.id = b.stream_id
         LEFT JOIN agents ra ON ra.id = b.author_agent_id
         WHERE b.kind = 'finding' AND ${feedbackConditions.join(" AND ")}
         ORDER BY b.created_at ASC`,
      feedbackParams
    ),

    pool.query<{
      total: string;
      approved: string;
      changesRequested: string;
    }>(
      `SELECT
          COUNT(*)::int AS total,
          -- A review stands where its findings do: approved once none is
          -- open, changes requested while any is.
          COUNT(*) FILTER (WHERE NOT st.any_open)::int AS approved,
          COUNT(*) FILTER (WHERE st.any_open)::int AS "changesRequested"
         FROM blocks b
         CROSS JOIN LATERAL (
           SELECT EXISTS (
             SELECT 1 FROM blocks f
              WHERE f.kind = 'finding' AND f.thread_id = b.id
                AND COALESCE(f.state->>'status', 'open') = 'open'
           ) AS any_open
         ) st
         JOIN agents pa ON pa.id = b.stream_id
         WHERE b.kind = 'review' AND ${verdictConditions.join(" AND ")}`,
      verdictParams
    ),
  ]);

  const rows = feedbackResult.rows;

  // Aggregate severity and status totals
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const byStatus = { open: 0, fixed: 0, ignored: 0, dismissed: 0 };
  for (const row of rows) {
    if (row.severity in bySeverity)
      bySeverity[row.severity as keyof typeof bySeverity]++;
    if (row.status in byStatus) byStatus[row.status as keyof typeof byStatus]++;
  }

  // Group by requested dimension
  const groupMap = new Map<string, typeof rows>();
  for (const row of rows) {
    let key: string;
    switch (params.groupBy) {
      case "persona":
        key = row.persona ?? "unknown";
        break;
      case "severity":
        key = row.severity;
        break;
      case "directory": {
        if (!row.filePath) {
          key = "(no file)";
          break;
        }
        const root = row.projectRoot;
        const relative =
          root && row.filePath.startsWith(root)
            ? row.filePath.slice(root.length + 1)
            : row.filePath;
        // Extract directory (drop the filename)
        const lastSlash = relative.lastIndexOf("/");
        key = lastSlash > 0 ? relative.slice(0, lastSlash) : ".";
        break;
      }
    }
    const list = groupMap.get(key) ?? [];
    list.push(row);
    groupMap.set(key, list);
  }

  // Build groups with top findings (exact match deduplication)
  const groups = [...groupMap.entries()]
    .map(([key, items]) => {
      const groupSev = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
      const descCounts = new Map<
        string,
        { count: number; severity: string; filePath: string | null }
      >();

      for (const item of items) {
        if (item.severity in groupSev)
          groupSev[item.severity as keyof typeof groupSev]++;
        const existing = descCounts.get(item.description);
        if (existing) {
          existing.count++;
        } else {
          descCounts.set(item.description, {
            count: 1,
            severity: item.severity,
            filePath: item.filePath,
          });
        }
      }

      const topFindings = [...descCounts.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 5)
        .map(([description, data]) => ({
          description,
          count: data.count,
          severity: data.severity,
          exampleFilePath: data.filePath,
        }));

      return {
        key,
        count: items.length,
        distinctFindings: descCounts.size,
        bySeverity: groupSev,
        topFindings,
      };
    })
    .sort((a, b) => b.count - a.count);

  const verdict = verdictResult.rows[0];

  return {
    period: { start: rangeStart.toISOString(), end: rangeEnd.toISOString() },
    totalFindings: rows.length,
    bySeverity,
    byStatus,
    groups,
    reviewVerdicts: {
      total: Number(verdict?.total ?? 0),
      approved: Number(verdict?.approved ?? 0),
      changesRequested: Number(verdict?.changesRequested ?? 0),
    },
  };
}

export async function listFiles(
  pool: Pool,
  agentId: string,
  fallbackFilesDir: (agentId: string) => string
): Promise<
  Array<{
    fileName: string;
    filePath: string;
    description: string | null;
    source: string;
    sizeBytes: number;
    createdAt: string;
  }>
> {
  const result = await pool.query<{
    fileName: string;
    description: string | null;
    source: string;
    sizeBytes: number;
    createdAt: Date;
    filesDir: string | null;
  }>(
    `SELECT m.file_name AS "fileName", m.description, m.source,
              m.size_bytes AS "sizeBytes", m.created_at AS "createdAt",
              a.files_dir AS "filesDir"
       FROM files m
       JOIN agents a ON a.id = m.agent_id
       WHERE m.agent_id = $1
       ORDER BY m.created_at`,
    [agentId]
  );
  return result.rows.map((row) => ({
    fileName: row.fileName,
    filePath: path.join(
      resolveConfiguredPath(row.filesDir ?? fallbackFilesDir(agentId)),
      row.fileName
    ),
    description: row.description,
    source: row.source,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
  }));
}
