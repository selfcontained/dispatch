import { randomUUID } from "node:crypto";
import path from "node:path";

import type { Pool } from "pg";

import { appendJobLog, validateJobReport, validateTerminalJobReport, type JobReport } from "./report.js";

export type JobNotifyConfig = {
  onComplete: string[];
  onError: string[];
  onNeedsInput: string[];
};

export type JobRunStatus = "started" | "running" | "completed" | "failed" | "needs_input" | "timed_out" | "crashed";
export type JobAgentType = "claude" | "codex" | "opencode";

export type JobRecord = {
  id: string;
  directory: string;
  name: string;
  filePath: string | null;
  schedule: string | null;
  timeoutMs: number | null;
  needsInputTimeoutMs: number | null;
  notify: JobNotifyConfig | null;
  prompt: string | null;
  enabled: boolean;
  agentType: JobAgentType;
  useWorktree: boolean;
  branchName: string | null;
  fullAccess: boolean;
  additionalInstructions: string | null;
  createdAt: string;
  updatedAt: string;
};

export type JobRunRecord = {
  id: string;
  jobId: string;
  agentId: string | null;
  status: JobRunStatus;
  report: JobReport | null;
  config: JobRunConfig;
  pendingQuestion: string | null;
  startedAt: string;
  statusUpdatedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  createdAt: string;
};

const ACTIVE_RUN_STATUSES: JobRunStatus[] = ["started", "running", "needs_input"];

export type JobWithLatestRun = JobRecord & {
  lastRunId: string | null;
  lastRunStatus: JobRunStatus | null;
  lastRunStartedAt: string | null;
  lastRunCompletedAt: string | null;
  lastRunDurationMs: number | null;
  lastRunReport: JobReport | null;
};

export type JobRunConfig = {
  directory: string;
  name: string;
  schedule: string | null;
  timeoutMs: number;
  needsInputTimeoutMs: number;
  notify: JobNotifyConfig;
  triggerSource?: "manual" | "scheduled";
};

export type JobConfigUpdate = {
  name?: string;
  prompt?: string | null;
  schedule?: string | null;
  timeoutMs?: number;
  needsInputTimeoutMs?: number;
  agentType?: JobAgentType;
  useWorktree?: boolean;
  branchName?: string | null;
  fullAccess?: boolean;
  additionalInstructions?: string | null;
  enabled?: boolean;
};

export type CreateJobInput = {
  name: string;
  directory: string;
  prompt: string;
  schedule?: string | null;
  timeoutMs?: number;
  needsInputTimeoutMs?: number;
  notify?: JobNotifyConfig | null;
  fullAccess?: boolean;
  agentType?: JobAgentType;
  useWorktree?: boolean;
  branchName?: string | null;
  additionalInstructions?: string | null;
  enabled?: boolean;
};

export class JobStore {
  constructor(private readonly pool: Pool) {}

  async createJob(input: CreateJobInput): Promise<JobRecord> {
    const id = randomUUID();
    const result = await this.pool.query(
      `
      INSERT INTO jobs (id, directory, name, schedule, timeout_ms, needs_input_timeout_ms, notify, prompt, full_access, agent_type, use_worktree, branch_name, additional_instructions, enabled)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14)
      RETURNING ${this.jobColumns()}
      `,
      [
        id,
        path.resolve(input.directory),
        input.name,
        input.schedule ?? null,
        input.timeoutMs ?? null,
        input.needsInputTimeoutMs ?? null,
        JSON.stringify(input.notify ?? { onComplete: [], onError: [], onNeedsInput: [] }),
        input.prompt,
        input.fullAccess ?? false,
        input.agentType ?? "codex",
        input.useWorktree ?? false,
        input.branchName ?? null,
        input.additionalInstructions ?? null,
        input.enabled ?? false,
      ]
    );
    return mapJob(result.rows[0]);
  }

  async findActiveRun(jobId: string): Promise<JobRunRecord | null> {
    const result = await this.pool.query(
      `
      SELECT ${this.runColumns()}
      FROM job_runs
      WHERE job_id = $1 AND status = ANY($2::text[])
      ORDER BY started_at DESC
      LIMIT 1
      `,
      [jobId, ACTIVE_RUN_STATUSES]
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async createRun(jobId: string, config: JobRunConfig): Promise<JobRunRecord> {
    const id = randomUUID();
    try {
      const result = await this.pool.query(
        `
        INSERT INTO job_runs (id, job_id, status, config)
        VALUES ($1, $2, 'started', $3::jsonb)
        RETURNING ${this.runColumns()}
        `,
        [id, jobId, JSON.stringify(config)]
      );
      return mapRun(result.rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const activeRun = await this.findActiveRun(jobId);
        throw new Error(`Job already has active run ${activeRun?.id ?? "unknown"}.`);
      }
      throw error;
    }
  }

  async attachAgent(runId: string, agentId: string): Promise<JobRunRecord> {
    const result = await this.pool.query(
      `
      UPDATE job_runs
      SET agent_id = $2, status = 'running', status_updated_at = NOW()
      WHERE id = $1
      RETURNING ${this.runColumns()}
      `,
      [runId, agentId]
    );
    if (!result.rows[0]) throw new Error(`Job run ${runId} not found.`);
    return mapRun(result.rows[0]);
  }

  async completeRunForAgent(agentId: string, report: unknown): Promise<JobRunRecord> {
    return this.setTerminalRunForAgent(agentId, "completed", validateTerminalJobReport(report, "completed"));
  }

  async failRunForAgent(agentId: string, report: unknown): Promise<JobRunRecord> {
    return this.setTerminalRunForAgent(agentId, "failed", validateTerminalJobReport(report, "failed"));
  }

  async markNeedsInputForAgent(agentId: string, question: string): Promise<JobRunRecord> {
    const trimmed = question.trim();
    if (!trimmed) throw new Error("question must be a non-empty string.");
    const result = await this.pool.query(
      `
      UPDATE job_runs
      SET status = 'needs_input',
          pending_question = $2,
          status_updated_at = NOW(),
          completed_at = NULL,
          duration_ms = NULL
      WHERE agent_id = $1 AND status = ANY($3::text[])
      RETURNING ${this.runColumns()}
      `,
      [agentId, trimmed, ACTIVE_RUN_STATUSES]
    );
    if (!result.rows[0]) throw new Error(`No active job run found for agent ${agentId}.`);
    return mapRun(result.rows[0]);
  }

  async logForAgent(agentId: string, input: {
    task: string;
    message: string;
    level: "debug" | "info" | "warn" | "error";
  }): Promise<JobRunRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query(
        `
        SELECT ${this.runColumns()}
        FROM job_runs
        WHERE agent_id = $1 AND status = ANY($2::text[])
        ORDER BY started_at DESC
        LIMIT 1
        FOR UPDATE
        `,
        [agentId, ACTIVE_RUN_STATUSES]
      );
      if (!locked.rows[0]) {
        await client.query("ROLLBACK");
        throw new Error(`No active job run found for agent ${agentId}.`);
      }
      const run = mapRun(locked.rows[0]);
      const report = appendJobLog(run.report, input);
      const result = await client.query(
        `
        UPDATE job_runs
        SET report = $2::jsonb
        WHERE id = $1
        RETURNING ${this.runColumns()}
        `,
        [run.id, JSON.stringify(report)]
      );
      await client.query("COMMIT");
      return mapRun(result.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async markTimedOut(runId: string, report: JobReport): Promise<JobRunRecord> {
    return this.setTerminalRun(runId, "timed_out", validateJobReport(report));
  }

  async markCrashed(runId: string, report: JobReport): Promise<JobRunRecord> {
    return this.setTerminalRun(runId, "crashed", validateJobReport(report));
  }

  async getRun(runId: string): Promise<JobRunRecord | null> {
    const result = await this.pool.query(`SELECT ${this.runColumns()} FROM job_runs WHERE id = $1`, [runId]);
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async getActiveRunForAgent(agentId: string): Promise<JobRunRecord | null> {
    const result = await this.pool.query(
      `
      SELECT ${this.runColumns()}
      FROM job_runs
      WHERE agent_id = $1 AND status = ANY($2::text[])
      ORDER BY started_at DESC
      LIMIT 1
      `,
      [agentId, ACTIVE_RUN_STATUSES]
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async getLatestRunForAgent(agentId: string): Promise<JobRunRecord | null> {
    const result = await this.pool.query(
      `
      SELECT ${this.runColumns()}
      FROM job_runs
      WHERE agent_id = $1
      ORDER BY started_at DESC
      LIMIT 1
      `,
      [agentId]
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async listActiveRuns(): Promise<JobRunRecord[]> {
    const result = await this.pool.query(
      `
      SELECT ${this.runColumns()}
      FROM job_runs
      WHERE status = ANY($1::text[])
      ORDER BY started_at ASC
      `,
      [ACTIVE_RUN_STATUSES]
    );
    return result.rows.map((row) => mapRun(row));
  }

  async listJobs(): Promise<JobWithLatestRun[]> {
    const result = await this.pool.query(`
      SELECT
        j.id, j.directory, j.name,
        j.file_path AS "filePath",
        j.schedule,
        j.timeout_ms AS "timeoutMs",
        j.needs_input_timeout_ms AS "needsInputTimeoutMs",
        j.notify,
        j.prompt,
        j.enabled,
        j.agent_type AS "agentType",
        j.use_worktree AS "useWorktree",
        j.branch_name AS "branchName",
        j.full_access AS "fullAccess",
        j.additional_instructions AS "additionalInstructions",
        j.created_at AS "createdAt",
        j.updated_at AS "updatedAt",
        lr.id AS "lastRunId",
        lr.status AS "lastRunStatus",
        lr.started_at AS "lastRunStartedAt",
        lr.completed_at AS "lastRunCompletedAt",
        lr.duration_ms AS "lastRunDurationMs",
        lr.report AS "lastRunReport"
      FROM jobs j
      LEFT JOIN LATERAL (
        SELECT id, status, started_at, completed_at, duration_ms, report
        FROM job_runs
        WHERE job_id = j.id
        ORDER BY started_at DESC
        LIMIT 1
      ) lr ON true
      ORDER BY j.name ASC, j.directory ASC
    `);
    return result.rows.map((row) => mapJobWithLatestRun(row));
  }

  async listRunsForJob(jobId: string, limit = 20): Promise<JobRunRecord[]> {
    const result = await this.pool.query(
      `
      SELECT ${this.runColumns()}
      FROM job_runs
      WHERE job_id = $1
      ORDER BY started_at DESC
      LIMIT $2
      `,
      [jobId, limit]
    );
    return result.rows.map((row) => mapRun(row));
  }

  async listRecentRuns(limit = 10): Promise<Array<{
    id: string;
    jobId: string;
    status: JobRunStatus;
    startedAt: string;
    durationMs: number | null;
    jobName: string;
  }>> {
    const result = await this.pool.query(
      `
      SELECT
        job_runs.id,
        job_runs.job_id AS "jobId",
        job_runs.status,
        job_runs.started_at AS "startedAt",
        job_runs.duration_ms AS "durationMs",
        j.name AS "jobName"
      FROM job_runs
      JOIN jobs j ON j.id = job_runs.job_id
      ORDER BY job_runs.started_at DESC
      LIMIT $1
      `,
      [limit]
    );
    return result.rows as Array<{
      id: string;
      jobId: string;
      status: JobRunStatus;
      startedAt: string;
      durationMs: number | null;
      jobName: string;
    }>;
  }

  async getRunStats(sinceDays = 7): Promise<{
    totalRuns: number;
    successCount: number;
    failureCount: number;
    avgDurationMs: number | null;
    daily: Array<{ day: string; completed: number; failed: number }>;
  }> {
    const [aggregates, daily] = await Promise.all([
      this.pool.query(
        `
        SELECT
          COUNT(*)::int AS "totalRuns",
          COUNT(*) FILTER (WHERE status = 'completed')::int AS "successCount",
          COUNT(*) FILTER (WHERE status IN ('failed', 'timed_out', 'crashed'))::int AS "failureCount",
          ROUND(AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL))::int AS "avgDurationMs"
        FROM job_runs
        WHERE started_at >= NOW() - make_interval(days => $1)
        `,
        [sinceDays]
      ),
      this.pool.query(
        `
        SELECT
          TO_CHAR(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
          COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
          COUNT(*) FILTER (WHERE status IN ('failed', 'timed_out', 'crashed'))::int AS failed
        FROM job_runs
        WHERE started_at >= NOW() - make_interval(days => $1)
        GROUP BY day
        ORDER BY day ASC
        `,
        [sinceDays]
      ),
    ]);
    const row = aggregates.rows[0];
    return {
      totalRuns: row.totalRuns ?? 0,
      successCount: row.successCount ?? 0,
      failureCount: row.failureCount ?? 0,
      avgDurationMs: row.avgDurationMs ?? null,
      daily: daily.rows.map((r) => ({
        day: r.day as string,
        completed: r.completed as number,
        failed: r.failed as number,
      })),
    };
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    const result = await this.pool.query(
      `SELECT ${this.jobColumns()} FROM jobs WHERE id = $1`,
      [jobId]
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async setEnabled(jobId: string, enabled: boolean): Promise<JobRecord> {
    const result = await this.pool.query(
      `
      UPDATE jobs
      SET enabled = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING ${this.jobColumns()}
      `,
      [jobId, enabled]
    );
    if (!result.rows[0]) throw new Error(`Job ${jobId} not found.`);
    return mapJob(result.rows[0]);
  }

  async updateJobConfig(jobId: string, input: JobConfigUpdate): Promise<JobRecord> {
    const result = await this.pool.query(
      `
      UPDATE jobs
      SET name = COALESCE($2, name),
          prompt = CASE WHEN $3 THEN $4 ELSE prompt END,
          schedule = CASE WHEN $5 THEN $6 ELSE schedule END,
          timeout_ms = COALESCE($7, timeout_ms),
          needs_input_timeout_ms = COALESCE($8, needs_input_timeout_ms),
          agent_type = COALESCE($9, agent_type),
          use_worktree = COALESCE($10, use_worktree),
          branch_name = CASE WHEN $11 THEN $12 ELSE branch_name END,
          full_access = COALESCE($13, full_access),
          additional_instructions = CASE WHEN $14 THEN $15 ELSE additional_instructions END,
          enabled = COALESCE($16, enabled),
          updated_at = NOW()
      WHERE id = $1
      RETURNING ${this.jobColumns()}
      `,
      [
        jobId,
        input.name,
        Object.prototype.hasOwnProperty.call(input, "prompt"),
        input.prompt ?? null,
        Object.prototype.hasOwnProperty.call(input, "schedule"),
        input.schedule ?? null,
        input.timeoutMs,
        input.needsInputTimeoutMs,
        input.agentType,
        input.useWorktree,
        Object.prototype.hasOwnProperty.call(input, "branchName"),
        input.branchName ?? null,
        input.fullAccess,
        Object.prototype.hasOwnProperty.call(input, "additionalInstructions"),
        input.additionalInstructions ?? null,
        input.enabled,
      ]
    );
    if (!result.rows[0]) throw new Error(`Job ${jobId} not found.`);
    return mapJob(result.rows[0]);
  }

  async deleteJob(jobId: string): Promise<JobRecord> {
    const result = await this.pool.query(
      `
      DELETE FROM jobs
      WHERE id = $1
      RETURNING ${this.jobColumns()}
      `,
      [jobId]
    );
    if (!result.rows[0]) throw new Error(`Job ${jobId} not found.`);
    return mapJob(result.rows[0]);
  }

  private async setTerminalRunForAgent(
    agentId: string,
    status: "completed" | "failed",
    report: JobReport
  ): Promise<JobRunRecord> {
    const run = await this.getActiveRunForAgent(agentId);
    if (!run) throw new Error(`No active job run found for agent ${agentId}.`);
    return this.setTerminalRun(run.id, status, report);
  }

  private async setTerminalRun(
    runId: string,
    status: Exclude<JobRunStatus, "started" | "running" | "needs_input">,
    report: JobReport
  ): Promise<JobRunRecord> {
    const result = await this.pool.query(
      `
      UPDATE job_runs
      SET status = $2,
          report = $3::jsonb,
          pending_question = NULL,
          status_updated_at = NOW(),
          completed_at = NOW(),
          duration_ms = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::integer)
      WHERE id = $1 AND status = ANY($4::text[])
      RETURNING ${this.runColumns()}
      `,
      [runId, status, JSON.stringify(report), ACTIVE_RUN_STATUSES]
    );
    if (!result.rows[0]) {
      const existing = await this.getRun(runId);
      if (!existing) throw new Error(`Job run ${runId} not found.`);
      throw new Error(`Job run ${runId} is no longer active (${existing.status}).`);
    }
    return mapRun(result.rows[0]);
  }

  private jobColumns(): string {
    return `
      id,
      directory,
      name,
      file_path AS "filePath",
      schedule,
      timeout_ms AS "timeoutMs",
      needs_input_timeout_ms AS "needsInputTimeoutMs",
      notify,
      prompt,
      enabled,
      agent_type AS "agentType",
      use_worktree AS "useWorktree",
      branch_name AS "branchName",
      full_access AS "fullAccess",
      additional_instructions AS "additionalInstructions",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    `;
  }

  private runColumns(): string {
    return `
      id,
      job_id AS "jobId",
      agent_id AS "agentId",
      status,
      report,
      config,
      pending_question AS "pendingQuestion",
      started_at AS "startedAt",
      status_updated_at AS "statusUpdatedAt",
      completed_at AS "completedAt",
      duration_ms AS "durationMs",
      created_at AS "createdAt"
    `;
  }
}

function mapJob(row: Record<string, unknown>): JobRecord {
  return row as JobRecord;
}

function mapRun(row: Record<string, unknown>): JobRunRecord {
  return row as JobRunRecord;
}

function mapJobWithLatestRun(row: Record<string, unknown>): JobWithLatestRun {
  return row as JobWithLatestRun;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
