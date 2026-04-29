import path from "node:path";

import type { Pool } from "pg";

import type { AgentGitContext, AgentPin } from "./types.js";

export type ActivitySummaryResult = {
  period: { start: string; end: string };
  projects: Array<{
    directory: string;
    totalWorkingMs: number;
    agentCount: number;
    sessionCount: number;
    outcomes: {
      done: number;
      idle: number;
      blocked: number;
      error: number;
    };
  }>;
  totals: {
    totalWorkingMs: number;
    agentCount: number;
    sessionCount: number;
  };
  topAgents: Array<{
    id: string;
    name: string;
    project: string;
    totalWorkingMs: number;
    latestEventMessage: string;
    latestEventType: string;
  }>;
};

export type AgentHistoryEntry = {
  id: string;
  name: string;
  type: string;
  project: string;
  status: string;
  createdAt: string;
  latestEventType: string | null;
  latestEventMessage: string | null;
  pins: Array<{ label: string; value: string; type: string }>;
  git: {
    branch: string | null;
    worktreeBranch: string | null;
  } | null;
  events?: Array<{
    type: string;
    message: string;
    createdAt: string;
  }>;
  feedback?: Array<{
    id: number;
    persona: string;
    severity: string;
    description: string;
    filePath: string | null;
    suggestion: string | null;
    status: string;
  }>;
  reviews?: Array<{
    persona: string;
    status: string;
    verdict: string | null;
    summary: string | null;
    filesReviewed: string[] | null;
  }>;
};

export type AgentHistoryResult = {
  agents: AgentHistoryEntry[];
  total: number;
  hasMore: boolean;
};

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

export async function getActivitySummary(
  pool: Pool,
  params: {
    start: Date;
    end: Date;
    project?: string;
  }
): Promise<ActivitySummaryResult> {
  const rangeStart = params.start;
  const rangeEnd = params.end;

  // Build optional project filter for working-time CTE
  const wtProjectFilter = params.project ? "AND project_dir = $3" : "";
  const wtParams: unknown[] = [rangeStart, rangeEnd];
  if (params.project) wtParams.push(params.project);

  // Build conditions for agents table queries
  const agentConditions = [
    "parent_agent_id IS NULL",
    "created_at >= $1",
    "created_at <= $2",
  ];
  const agentParams: unknown[] = [rangeStart, rangeEnd];
  if (params.project) {
    agentParams.push(params.project);
    agentConditions.push(
      `COALESCE(git_context->>'repoRoot', cwd) = $${agentParams.length}`
    );
  }
  const agentWhere = `WHERE ${agentConditions.join(" AND ")}`;

  // Run all three queries in parallel
  const [workingTimeResult, sessionResult, agentMetaResult] = await Promise.all(
    [
      // Query 1: Working time per agent per project via SQL window functions
      pool.query<{
        agentId: string;
        projectDir: string;
        totalWorkingMs: string;
      }>(
        `WITH boundary AS (
          SELECT DISTINCT ON (ae.agent_id)
            ae.agent_id, ae.event_type,
            $1::timestamptz AS effective_at,
            COALESCE(ae.project_dir, a.cwd) AS project_dir
          FROM agent_events ae
          JOIN agents a ON a.id = ae.agent_id
            AND a.parent_agent_id IS NULL
          WHERE ae.created_at < $1
          ORDER BY ae.agent_id, ae.created_at DESC
        ),
        in_range AS (
          SELECT ae.agent_id, ae.event_type, ae.created_at AS effective_at,
                 COALESCE(ae.project_dir, a.cwd) AS project_dir
          FROM agent_events ae
          JOIN agents a ON a.id = ae.agent_id
            AND a.parent_agent_id IS NULL
          WHERE ae.created_at >= $1 AND ae.created_at <= $2
        ),
        all_events AS (
          SELECT * FROM boundary UNION ALL SELECT * FROM in_range
        ),
        with_next AS (
          SELECT agent_id, event_type, effective_at, project_dir,
                 LEAD(effective_at) OVER (PARTITION BY agent_id ORDER BY effective_at) AS next_at
          FROM all_events
        )
        SELECT
          agent_id AS "agentId",
          project_dir AS "projectDir",
          COALESCE(SUM(
            CASE WHEN event_type = 'working'
            THEN EXTRACT(EPOCH FROM (
              COALESCE(next_at, LEAST($2::timestamptz, NOW())) - effective_at
            )) * 1000
            ELSE 0 END
          ), 0)::bigint AS "totalWorkingMs"
        FROM with_next
        WHERE project_dir IS NOT NULL ${wtProjectFilter}
        GROUP BY agent_id, project_dir`,
        wtParams
      ),

      // Query 2: Session counts and outcomes by project
      pool.query<{
        projectDir: string;
        sessionCount: string;
        doneCount: string;
        idleCount: string;
        blockedCount: string;
        errorCount: string;
      }>(
        `SELECT
          COALESCE(git_context->>'repoRoot', cwd) AS "projectDir",
          COUNT(*)::int AS "sessionCount",
          COUNT(*) FILTER (WHERE latest_event_type = 'done')::int AS "doneCount",
          COUNT(*) FILTER (WHERE latest_event_type = 'idle')::int AS "idleCount",
          COUNT(*) FILTER (WHERE latest_event_type = 'blocked')::int AS "blockedCount",
          COUNT(*) FILTER (WHERE status = 'error')::int AS "errorCount"
        FROM agents
        ${agentWhere}
        GROUP BY COALESCE(git_context->>'repoRoot', cwd)`,
        agentParams
      ),

      // Query 3: Agent metadata for top agents list
      pool.query<{
        id: string;
        name: string;
        projectDir: string;
        latestEventType: string | null;
        latestEventMessage: string | null;
      }>(
        `SELECT id, name,
          COALESCE(git_context->>'repoRoot', cwd) AS "projectDir",
          latest_event_type AS "latestEventType",
          latest_event_message AS "latestEventMessage"
        FROM agents
        ${agentWhere}`,
        agentParams
      ),
    ]
  );

  // Aggregate working time by project and by agent
  const projectWorkingTime = new Map<
    string,
    { totalWorkingMs: number; agents: Set<string> }
  >();
  const workingTimeByAgent = new Map<
    string,
    { project: string; totalWorkingMs: number }
  >();

  for (const row of workingTimeResult.rows) {
    const ms = Number(row.totalWorkingMs);

    // Per-project aggregation
    const proj = projectWorkingTime.get(row.projectDir) ?? {
      totalWorkingMs: 0,
      agents: new Set(),
    };
    proj.totalWorkingMs += ms;
    proj.agents.add(row.agentId);
    projectWorkingTime.set(row.projectDir, proj);

    // Per-agent aggregation (for top agents)
    const agent = workingTimeByAgent.get(row.agentId);
    if (agent) {
      agent.totalWorkingMs += ms;
    } else {
      workingTimeByAgent.set(row.agentId, {
        project: row.projectDir,
        totalWorkingMs: ms,
      });
    }
  }

  // Index session data by project
  const sessionsByProject = new Map(
    sessionResult.rows.map((r) => [r.projectDir, r])
  );

  // Merge project-level data
  const allProjectDirs = new Set([
    ...projectWorkingTime.keys(),
    ...sessionsByProject.keys(),
  ]);
  const projects = [...allProjectDirs]
    .map((dir) => {
      const working = projectWorkingTime.get(dir);
      const sessions = sessionsByProject.get(dir);
      return {
        directory: dir,
        totalWorkingMs: working?.totalWorkingMs ?? 0,
        agentCount: working?.agents.size ?? 0,
        sessionCount: Number(sessions?.sessionCount ?? 0),
        outcomes: {
          done: Number(sessions?.doneCount ?? 0),
          idle: Number(sessions?.idleCount ?? 0),
          blocked: Number(sessions?.blockedCount ?? 0),
          error: Number(sessions?.errorCount ?? 0),
        },
      };
    })
    .sort((a, b) => b.totalWorkingMs - a.totalWorkingMs);

  // Build top agents list
  const agentMeta = new Map(agentMetaResult.rows.map((r) => [r.id, r]));
  const topAgents = [...workingTimeByAgent.entries()]
    .sort((a, b) => b[1].totalWorkingMs - a[1].totalWorkingMs)
    .slice(0, 10)
    .map(([id, data]) => {
      const meta = agentMeta.get(id);
      return {
        id,
        name: meta?.name ?? id,
        project: data.project,
        totalWorkingMs: data.totalWorkingMs,
        latestEventMessage: meta?.latestEventMessage ?? "",
        latestEventType: meta?.latestEventType ?? "",
      };
    });

  return {
    period: { start: rangeStart.toISOString(), end: rangeEnd.toISOString() },
    projects,
    totals: {
      totalWorkingMs: projects.reduce((sum, p) => sum + p.totalWorkingMs, 0),
      agentCount: new Set(workingTimeResult.rows.map((r) => r.agentId)).size,
      sessionCount: projects.reduce((sum, p) => sum + p.sessionCount, 0),
    },
    topAgents,
  };
}

export async function getAgentHistory(
  pool: Pool,
  params: {
    start: Date;
    end: Date;
    project?: string;
    limit: number;
    offset: number;
    includeEvents: boolean;
    includeFeedback: boolean;
    includeReviews: boolean;
    includeChildren: boolean;
  }
): Promise<AgentHistoryResult> {
  const conditions: string[] = ["created_at >= $1", "created_at <= $2"];
  const queryParams: unknown[] = [params.start, params.end];

  if (!params.includeChildren) {
    conditions.push("parent_agent_id IS NULL");
  }
  if (params.project) {
    queryParams.push(params.project);
    conditions.push(
      `COALESCE(git_context->>'repoRoot', cwd) = $${queryParams.length}`
    );
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  // Count + paginated list in parallel
  const [countResult, listResult] = await Promise.all([
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM agents ${whereClause}`,
      queryParams
    ),
    pool.query<{
      id: string;
      name: string;
      type: string;
      status: string;
      projectDir: string;
      createdAt: string;
      latestEventType: string | null;
      latestEventMessage: string | null;
      pins: AgentPin[];
      gitContext: AgentGitContext | null;
      worktreeBranch: string | null;
      persona: string | null;
      parentAgentId: string | null;
    }>(
      `SELECT id, name, type, status,
          COALESCE(git_context->>'repoRoot', cwd) AS "projectDir",
          created_at AS "createdAt",
          latest_event_type AS "latestEventType",
          latest_event_message AS "latestEventMessage",
          pins,
          git_context AS "gitContext",
          worktree_branch AS "worktreeBranch",
          persona,
          parent_agent_id AS "parentAgentId"
        FROM agents ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`,
      [...queryParams, params.limit, params.offset]
    ),
  ]);

  const total = Number(countResult.rows[0]?.count ?? 0);
  const agentIds = listResult.rows.map((a) => a.id);
  // Parent agent IDs for feedback/review lookups (when children are shown standalone,
  // feedback still groups under parent)
  const parentAgentIds = listResult.rows
    .filter((a) => !a.parentAgentId)
    .map((a) => a.id);

  // Fetch related data in parallel
  const [eventsRows, feedbackRows, reviewsRows] = await Promise.all([
    params.includeEvents && agentIds.length > 0
      ? pool
          .query<{
            agentId: string;
            type: string;
            message: string;
            createdAt: string;
          }>(
            `SELECT agent_id AS "agentId", event_type AS type, message,
                    created_at AS "createdAt"
             FROM (
               SELECT *, ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY created_at ASC) AS rn
               FROM agent_events
               WHERE agent_id = ANY($1)
             ) ranked
             WHERE rn <= 200
             ORDER BY agent_id, created_at ASC`,
            [agentIds]
          )
          .then((r) => r.rows)
      : [],
    params.includeFeedback && parentAgentIds.length > 0
      ? pool
          .query<{
            parentAgentId: string;
            id: number;
            persona: string;
            severity: string;
            description: string;
            filePath: string | null;
            suggestion: string | null;
            status: string;
          }>(
            `SELECT a.parent_agent_id AS "parentAgentId",
                    f.id, a.persona, f.severity, f.description,
                    f.file_path AS "filePath", f.suggestion, f.status
             FROM agent_feedback f
             JOIN agents a ON a.id = f.agent_id
             WHERE a.parent_agent_id = ANY($1)
             ORDER BY f.created_at ASC`,
            [parentAgentIds]
          )
          .then((r) => r.rows)
      : [],
    params.includeReviews && parentAgentIds.length > 0
      ? pool
          .query<{
            parentAgentId: string;
            persona: string;
            status: string;
            verdict: string | null;
            summary: string | null;
            filesReviewed: string[] | null;
          }>(
            `SELECT parent_agent_id AS "parentAgentId", persona, status,
                    verdict, summary, files_reviewed AS "filesReviewed"
             FROM persona_reviews
             WHERE parent_agent_id = ANY($1)
             ORDER BY created_at ASC`,
            [parentAgentIds]
          )
          .then((r) => r.rows)
      : [],
  ]);

  // Group related data by agent ID
  const eventsByAgent = new Map<
    string,
    Array<{ type: string; message: string; createdAt: string }>
  >();
  for (const row of eventsRows) {
    const list = eventsByAgent.get(row.agentId) ?? [];
    list.push({
      type: row.type,
      message: row.message,
      createdAt: row.createdAt,
    });
    eventsByAgent.set(row.agentId, list);
  }

  const feedbackByParent = new Map<
    string,
    Array<{
      id: number;
      persona: string;
      severity: string;
      description: string;
      filePath: string | null;
      suggestion: string | null;
      status: string;
    }>
  >();
  for (const row of feedbackRows) {
    const list = feedbackByParent.get(row.parentAgentId) ?? [];
    list.push({
      id: row.id,
      persona: row.persona,
      severity: row.severity,
      description: row.description,
      filePath: row.filePath,
      suggestion: row.suggestion,
      status: row.status,
    });
    feedbackByParent.set(row.parentAgentId, list);
  }

  const reviewsByParent = new Map<
    string,
    Array<{
      persona: string;
      status: string;
      verdict: string | null;
      summary: string | null;
      filesReviewed: string[] | null;
    }>
  >();
  for (const row of reviewsRows) {
    const list = reviewsByParent.get(row.parentAgentId) ?? [];
    list.push({
      persona: row.persona,
      status: row.status,
      verdict: row.verdict,
      summary: row.summary,
      filesReviewed: row.filesReviewed,
    });
    reviewsByParent.set(row.parentAgentId, list);
  }

  const agents: AgentHistoryEntry[] = listResult.rows.map((a) => ({
    id: a.id,
    name: a.name,
    type: a.type,
    project: a.projectDir,
    status: a.status,
    createdAt: a.createdAt,
    latestEventType: a.latestEventType,
    latestEventMessage: a.latestEventMessage,
    pins: (a.pins ?? []).map((p) => ({
      label: p.label,
      value: p.value,
      type: p.type,
    })),
    git: a.gitContext
      ? {
          branch: a.gitContext.branch ?? null,
          worktreeBranch: a.worktreeBranch,
        }
      : null,
    ...(params.includeEvents ? { events: eventsByAgent.get(a.id) ?? [] } : {}),
    ...(params.includeFeedback
      ? { feedback: feedbackByParent.get(a.id) ?? [] }
      : {}),
    ...(params.includeReviews
      ? { reviews: reviewsByParent.get(a.id) ?? [] }
      : {}),
  }));

  return { agents, total, hasMore: params.offset + params.limit < total };
}

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

  const feedbackConditions = ["f.created_at >= $1", "f.created_at <= $2"];
  const feedbackParams: unknown[] = [rangeStart, rangeEnd];
  if (params.project) {
    feedbackParams.push(params.project);
    feedbackConditions.push(
      `COALESCE(pa.git_context->>'repoRoot', pa.cwd, a.cwd) = $${feedbackParams.length}`
    );
  }

  const verdictConditions = ["pr.created_at >= $1", "pr.created_at <= $2"];
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
      `SELECT a.persona, f.severity, f.description,
                f.file_path AS "filePath", f.status,
                COALESCE(pa.git_context->>'repoRoot', pa.cwd, a.cwd) AS "projectRoot"
         FROM agent_feedback f
         JOIN agents a ON a.id = f.agent_id
         LEFT JOIN agents pa ON pa.id = a.parent_agent_id
         WHERE ${feedbackConditions.join(" AND ")}
         ORDER BY f.created_at ASC`,
      feedbackParams
    ),

    pool.query<{
      total: string;
      approved: string;
      changesRequested: string;
    }>(
      `SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE pr.verdict = 'approve')::int AS approved,
          COUNT(*) FILTER (WHERE pr.verdict = 'request_changes')::int AS "changesRequested"
         FROM persona_reviews pr
         JOIN agents pa ON pa.id = pr.parent_agent_id
         WHERE ${verdictConditions.join(" AND ")}`,
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

      return { key, count: items.length, bySeverity: groupSev, topFindings };
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

export async function listMedia(
  pool: Pool,
  agentId: string,
  fallbackMediaDir: (agentId: string) => string
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
    mediaDir: string | null;
  }>(
    `SELECT m.file_name AS "fileName", m.description, m.source,
              m.size_bytes AS "sizeBytes", m.created_at AS "createdAt",
              a.media_dir AS "mediaDir"
       FROM media m
       JOIN agents a ON a.id = m.agent_id
       WHERE m.agent_id = $1
       ORDER BY m.created_at`,
    [agentId]
  );
  return result.rows.map((row) => ({
    fileName: row.fileName,
    filePath: path.join(
      row.mediaDir ?? fallbackMediaDir(agentId),
      row.fileName
    ),
    description: row.description,
    source: row.source,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
  }));
}
