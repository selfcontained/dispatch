import { randomUUID } from "node:crypto";
import path from "node:path";

import type { Pool } from "pg";

import type { CliAgentType } from "../shared/agent-types.js";
import { isUniqueViolation } from "../shared/lib/pg-errors.js";
import {
  appendJobLog,
  validateJobReport,
  validateTerminalJobReport,
  type JobReport,
} from "./report.js";

// The job wire types below (JobNotifyConfig, JobRunStatus, JobAgentType,
// JobRecord, JobRunRecord, JobWithLatestRun, AddJobInput) are imported
// type-only by the web client (apps/web/src/hooks/use-jobs.ts) so both sides
// of the API agree on one definition.
export type JobNotifyConfig = {
  onComplete: string[];
  onError: string[];
  onNeedsInput: string[];
};

export type JobRunStatus =
  | "started"
  | "running"
  | "completed"
  | "failed"
  | "needs_input"
  | "timed_out"
  | "crashed";
export type JobAgentType = CliAgentType;

export type JobRecord = {
  id: string;
  directory: string;
  name: string;
  schedule: string | null;
  timeoutMs: number | null;
  needsInputTimeoutMs: number | null;
  notify: JobNotifyConfig | null;
  prompt: string | null;
  enabled: boolean;
  agentType: JobAgentType;
  model: string | null;
  useWorktree: boolean;
  baseBranch: string | null;
  branchName: string | null;
  fullAccess: boolean;
  autoArchive: boolean;
  callable: boolean;
  singleton: boolean;
  webhookEnabled: boolean;
  webhookSecret: string | null;
  templateId: string | null;
  defaultArgs: Record<string, string>;
  selfImprove: boolean;
  continuationEnabled?: boolean;
  maxIterations?: number | null;
  completionCriteria?: string[] | null;
  recoveryInstructions?: string | null;
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
  chainId: string | null;
  chainIteration: number | null;
  continuation: ContinuationStatus | null;
  continuationPending: boolean;
  continuationRetries: number;
};

export type ContinuationStatus = {
  action: "default" | "continue" | "pause" | "finish";
  phase?: string;
  summary?: string;
  nextIntent?: string;
  filePaths?: string[];
  blockers?: string[];
};

const ACTIVE_RUN_STATUSES: JobRunStatus[] = [
  "started",
  "running",
  "needs_input",
];

export type JobWithLatestRun = JobRecord & {
  lastRunId: string | null;
  lastRunStatus: JobRunStatus | null;
  lastRunStartedAt: string | null;
  lastRunCompletedAt: string | null;
  lastRunDurationMs: number | null;
  lastRunReport: JobReport | null;
  continuationPending: boolean;
  lastRunChainId: string | null;
  lastRunIteration: number | null;
};

export type JobRunConfig = {
  directory: string;
  name: string;
  schedule: string | null;
  timeoutMs: number;
  needsInputTimeoutMs: number;
  notify: JobNotifyConfig;
  triggerSource?: "manual" | "scheduled" | "webhook" | "continuation";
  autoArchive?: boolean;
  continuationEnabled?: boolean;
  maxIterations?: number | null;
  chainId?: string;
  iteration?: number;
  continuationOfRunId?: string;
  recoveryAttempt?: number;
  previousHandoffKey?: string;
};

export type AddJobInput = {
  name: string;
  directory: string;
  displayName?: string;
  prompt?: string | null;
  schedule?: string | null;
  timeoutMs?: number;
  needsInputTimeoutMs?: number;
  agentType?: JobAgentType;
  model?: string | null;
  useWorktree?: boolean;
  baseBranch?: string | null;
  branchName?: string | null;
  fullAccess?: boolean;
  autoArchive?: boolean;
  callable?: boolean;
  singleton?: boolean;
  webhookEnabled?: boolean;
  defaultArgs?: Record<string, string>;
  enabled?: boolean;
  selfImprove?: boolean;
  continuationEnabled?: boolean;
  maxIterations?: number | null;
  completionCriteria?: string[] | null;
  recoveryInstructions?: string | null;
};

export type JobConfigUpdate = {
  name?: string;
  prompt?: string | null;
  schedule?: string | null;
  timeoutMs?: number;
  needsInputTimeoutMs?: number;
  agentType?: JobAgentType;
  model?: string | null;
  useWorktree?: boolean;
  baseBranch?: string | null;
  branchName?: string | null;
  fullAccess?: boolean;
  autoArchive?: boolean;
  callable?: boolean;
  singleton?: boolean;
  webhookEnabled?: boolean;
  webhookSecret?: string | null;
  templateId?: string | null;
  defaultArgs?: Record<string, string>;
  enabled?: boolean;
  selfImprove?: boolean;
  continuationEnabled?: boolean;
  maxIterations?: number | null;
  completionCriteria?: string[] | null;
  recoveryInstructions?: string | null;
};

export class JobStore {
  constructor(private readonly pool: Pool) {}

  async createJob(input: {
    name: string;
    directory: string;
    prompt: string | null;
    schedule: string | null;
    timeoutMs: number;
    needsInputTimeoutMs: number;
    agentType: JobAgentType;
    model?: string | null;
    useWorktree: boolean;
    baseBranch: string | null;
    branchName: string | null;
    fullAccess: boolean;
    autoArchive: boolean;
    callable: boolean;
    singleton: boolean;
    webhookEnabled: boolean;
    webhookSecret: string | null;
    templateId?: string | null;
    defaultArgs?: Record<string, string>;
    enabled: boolean;
    selfImprove?: boolean;
    continuationEnabled?: boolean;
    maxIterations?: number | null;
    completionCriteria?: string[] | null;
    recoveryInstructions?: string | null;
  }): Promise<JobRecord> {
    const id = randomUUID();
    try {
      const result = await this.pool.query(
        `
        INSERT INTO jobs (id, directory, name, schedule, timeout_ms, needs_input_timeout_ms, prompt, full_access, agent_type, model, use_worktree, base_branch, branch_name, auto_archive, callable, singleton, webhook_enabled, webhook_secret, template_id, default_args, enabled, self_improve, continuation_enabled, max_iterations, completion_criteria, recovery_instructions)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21, $22, $23, $24, $25, $26)
        RETURNING ${this.jobColumns()}
        `,
        [
          id,
          path.resolve(input.directory),
          input.name,
          input.schedule,
          input.timeoutMs,
          input.needsInputTimeoutMs,
          input.prompt,
          input.fullAccess,
          input.agentType,
          input.model ?? null,
          input.useWorktree,
          input.baseBranch,
          input.branchName,
          input.autoArchive,
          input.callable,
          input.singleton,
          input.webhookEnabled,
          input.webhookSecret,
          input.templateId ?? null,
          JSON.stringify(input.defaultArgs ?? {}),
          input.enabled,
          input.selfImprove ?? false,
          input.continuationEnabled ?? false,
          input.maxIterations ?? null,
          input.completionCriteria ?? null,
          input.recoveryInstructions ?? null,
        ]
      );
      return mapJob(result.rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new Error(
          `A job named "${input.name}" already exists in directory "${input.directory}".`
        );
      }
      throw error;
    }
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

  async findPendingContinuation(jobId: string): Promise<JobRunRecord | null> {
    const result = await this.pool.query(
      `SELECT ${this.runColumns()} FROM job_runs WHERE job_id = $1 AND continuation_pending = TRUE ORDER BY started_at DESC LIMIT 1`,
      [jobId]
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async listPendingContinuations(): Promise<JobRunRecord[]> {
    const result = await this.pool.query(
      `SELECT ${this.runColumns()} FROM job_runs WHERE continuation_pending = TRUE ORDER BY started_at ASC`
    );
    return result.rows.map(mapRun);
  }

  /** Successors reserved before a process crash have an active barrier but no agent. */
  async listReservedContinuationRuns(): Promise<JobRunRecord[]> {
    const result = await this.pool.query(
      `SELECT ${this.runColumns()} FROM job_runs
       WHERE status = 'started' AND agent_id IS NULL
         AND config->>'triggerSource' = 'continuation'
       ORDER BY started_at ASC`
    );
    return result.rows.map(mapRun);
  }

  /** Mark one infrastructure failure as eligible for a same-iteration retry. */
  async scheduleRecovery(runId: string): Promise<JobRunRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // All continuation state transitions take job then run locks. This also
      // serializes a recovery against disable and successor reservation.
      const jobResult = await client.query(
        `SELECT j.id FROM jobs j JOIN job_runs r ON r.job_id = j.id
         WHERE r.id = $1 FOR UPDATE OF j`,
        [runId]
      );
      if (!jobResult.rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      const result = await client.query(
        `UPDATE job_runs r
         SET continuation_pending = TRUE
         FROM jobs j
         WHERE r.id = $1 AND r.job_id = j.id
           AND r.status = ANY($2::text[])
           AND r.continuation_pending = FALSE
           AND COALESCE((r.config->>'recoveryAttempt')::integer, 0) = 0
           AND j.enabled = TRUE AND j.continuation_enabled = TRUE
         RETURNING ${this.runColumns("r")}`,
        [runId, ["crashed", "timed_out"]]
      );
      await client.query("COMMIT");
      return result.rows[0] ? mapRun(result.rows[0]) : null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Atomically replace a pending predecessor with a started successor.  The
   * successor row is deliberately created before the predecessor's pending
   * marker is removed, so every trigger observes a run/pending barrier for
   * the entire handoff.
   */
  async startPendingContinuation(
    runId: string,
    config: JobRunConfig
  ): Promise<{ predecessor: JobRunRecord; successor: JobRunRecord } | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const jobResult = await client.query(
        `SELECT j.* FROM jobs j JOIN job_runs r ON r.job_id = j.id
         WHERE r.id = $1 FOR UPDATE OF j`,
        [runId]
      );
      if (
        !jobResult.rows[0]?.continuation_enabled ||
        !jobResult.rows[0]?.enabled
      ) {
        await client.query("COMMIT");
        return null;
      }
      const predecessorResult = await client.query(
        `SELECT ${this.runColumns()} FROM job_runs WHERE id = $1 AND continuation_pending = TRUE FOR UPDATE`,
        [runId]
      );
      if (!predecessorResult.rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      const predecessor = mapRun(predecessorResult.rows[0]);
      const successorResult = await client.query(
        `INSERT INTO job_runs (id, job_id, status, config, chain_id, chain_iteration)
         VALUES ($1, $2, 'started', $3::jsonb, $4, $5) RETURNING ${this.runColumns()}`,
        [
          randomUUID(),
          predecessor.jobId,
          JSON.stringify(config),
          config.chainId ?? null,
          config.iteration ?? null,
        ]
      );
      await client.query(
        `UPDATE job_runs SET continuation_pending = FALSE WHERE id = $1`,
        [runId]
      );
      await client.query("COMMIT");
      return { predecessor, successor: mapRun(successorResult.rows[0]) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async restorePendingContinuation(
    runId: string
  ): Promise<JobRunRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const job = await client.query(
        `SELECT j.id FROM jobs j JOIN job_runs r ON r.job_id = j.id
         WHERE r.id = $1 AND j.enabled = TRUE AND j.continuation_enabled = TRUE
         FOR UPDATE OF j`,
        [runId]
      );
      if (!job.rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      const result = await client.query(
        `UPDATE job_runs SET continuation_pending = TRUE,
           continuation_retries = continuation_retries + 1
         WHERE id = $1 RETURNING ${this.runColumns()}`,
        [runId]
      );
      await client.query("COMMIT");
      return result.rows[0] ? mapRun(result.rows[0]) : null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async pausePendingContinuation(runId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const job = await client.query(
        `SELECT j.id FROM jobs j JOIN job_runs r ON r.job_id = j.id
         WHERE r.id = $1 FOR UPDATE OF j`,
        [runId]
      );
      if (job.rows[0])
        await client.query(
          `UPDATE job_runs SET continuation_pending = FALSE WHERE id = $1`,
          [runId]
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async createRun(jobId: string, config: JobRunConfig): Promise<JobRunRecord> {
    const id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const jobResult = await client.query(
        `SELECT singleton, continuation_enabled, enabled FROM jobs WHERE id = $1 FOR UPDATE`,
        [jobId]
      );
      const job = jobResult.rows[0];
      if (!job) throw new Error(`Job ${jobId} not found.`);
      // Explicit Run now seeds a continuation loop even when it was merely
      // armed. Scheduled and webhook triggers continue to respect enabled.
      if (
        config.triggerSource === "manual" &&
        job.continuation_enabled &&
        !job.enabled
      ) {
        await client.query(
          `UPDATE jobs SET enabled = TRUE, updated_at = NOW() WHERE id = $1`,
          [jobId]
        );
      }
      if (
        (config.triggerSource === "scheduled" ||
          (config.triggerSource === "webhook" && job.continuation_enabled)) &&
        !job.enabled
      ) {
        throw new Error(`Job ${jobId} is disabled.`);
      }
      if (job.singleton || job.continuation_enabled) {
        const barrier = await client.query(
          `SELECT id, status, continuation_pending FROM job_runs
           WHERE job_id = $1
             AND (status = ANY($2::text[]) OR continuation_pending = TRUE)
           LIMIT 1 FOR UPDATE`,
          [jobId, ACTIVE_RUN_STATUSES]
        );
        if (barrier.rows[0]) {
          const existing = barrier.rows[0];
          throw new Error(
            existing.continuation_pending
              ? `Job already has pending continuation work (${existing.id}).`
              : `Job already has active run ${existing.id} (${existing.status}).`
          );
        }
      }
      const result = await client.query(
        `
        INSERT INTO job_runs (id, job_id, status, config, chain_id, chain_iteration)
        VALUES ($1, $2, 'started', $3::jsonb, $4, $5)
        RETURNING ${this.runColumns()}
        `,
        [
          id,
          jobId,
          JSON.stringify(config),
          config.chainId ?? null,
          config.iteration ?? null,
        ]
      );
      await client.query("COMMIT");
      return mapRun(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (isUniqueViolation(error)) {
        const activeRun = await this.findActiveRun(jobId);
        throw new Error(
          `Job already has active run ${activeRun?.id ?? "unknown"}.`
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async attachAgent(runId: string, agentId: string): Promise<JobRunRecord> {
    const result = await this.pool.query(
      `
      UPDATE job_runs
      SET agent_id = $2, status = 'running', status_updated_at = NOW()
      WHERE id = $1 AND agent_id IS NULL
      RETURNING ${this.runColumns()}
      `,
      [runId, agentId]
    );
    if (!result.rows[0]) throw new Error(`Job run ${runId} not found.`);
    return mapRun(result.rows[0]);
  }

  async completeRunForAgent(
    agentId: string,
    report: unknown
  ): Promise<JobRunRecord> {
    const validated = validateTerminalJobReport(report, "completed");
    const continuation = validateContinuationStatus(report) ?? {
      action: "default" as const,
      summary: validated.summary,
    };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const job = await client.query(
        `SELECT j.* FROM jobs j JOIN job_runs r ON r.job_id = j.id
         WHERE r.agent_id = $1 AND r.status = ANY($2::text[])
         LIMIT 1 FOR UPDATE OF j`,
        [agentId, ACTIVE_RUN_STATUSES]
      );
      if (!job.rows[0])
        throw new Error(`No active job run found for agent ${agentId}.`);
      const lockedRun = await client.query(
        `SELECT ${this.runColumns()} FROM job_runs
         WHERE agent_id = $1 AND status = ANY($2::text[])
         LIMIT 1 FOR UPDATE`,
        [agentId, ACTIVE_RUN_STATUSES]
      );
      if (!lockedRun.rows[0])
        throw new Error(`No active job run found for agent ${agentId}.`);
      let run = mapRun(lockedRun.rows[0]);
      const enabled = Boolean(
        job.rows[0]?.continuation_enabled && job.rows[0]?.enabled
      );
      const cap = job.rows[0]?.max_iterations as number | null | undefined;
      const iteration = run.chainIteration ?? 1;
      const shouldContinue =
        enabled &&
        (continuation.action === "continue" ||
          continuation.action === "default") &&
        (cap == null || iteration < cap);
      if (shouldContinue && !continuation.nextIntent)
        throw new Error(
          "report.continuation.nextIntent is required when continuing a Loop job."
        );
      const result = await client.query(
        `UPDATE job_runs SET status = 'completed', report = $2::jsonb,
         continuation = $3::jsonb, continuation_pending = FALSE,
         status_updated_at = NOW(), completed_at = NOW(),
         duration_ms = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::integer)
         WHERE id = $1 RETURNING ${this.runColumns()}`,
        [run.id, JSON.stringify(validated), JSON.stringify(continuation)]
      );
      run = mapRun(result.rows[0]);
      if (continuation.action === "finish")
        await client.query(
          `UPDATE jobs SET enabled = FALSE, updated_at = NOW() WHERE id = $1`,
          [run.jobId]
        );
      const pending = await client.query(
        `UPDATE job_runs SET continuation_pending = $2 WHERE id = $1 RETURNING ${this.runColumns()}`,
        [run.id, shouldContinue]
      );
      run = mapRun(pending.rows[0]);
      await client.query("COMMIT");
      return run;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async failRunForAgent(
    agentId: string,
    report: unknown
  ): Promise<JobRunRecord> {
    return this.setTerminalRunForAgent(
      agentId,
      "failed",
      validateTerminalJobReport(report, "failed")
    );
  }

  async markNeedsInputForAgent(
    agentId: string,
    question: string
  ): Promise<JobRunRecord> {
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
    if (!result.rows[0])
      throw new Error(`No active job run found for agent ${agentId}.`);
    return mapRun(result.rows[0]);
  }

  async logForAgent(
    agentId: string,
    input: {
      task: string;
      message: string;
      level: "debug" | "info" | "warn" | "error";
    }
  ): Promise<JobRunRecord> {
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
    const result = await this.pool.query(
      `SELECT ${this.runColumns()} FROM job_runs WHERE id = $1`,
      [runId]
    );
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
        j.schedule,
        j.timeout_ms AS "timeoutMs",
        j.needs_input_timeout_ms AS "needsInputTimeoutMs",
        j.notify,
        j.prompt,
        j.enabled,
        j.agent_type AS "agentType",
        j.model,
        j.use_worktree AS "useWorktree",
        j.base_branch AS "baseBranch",
        j.branch_name AS "branchName",
        j.full_access AS "fullAccess",
        j.auto_archive AS "autoArchive",
        j.callable,
        j.singleton,
        j.webhook_enabled AS "webhookEnabled",
        j.webhook_secret AS "webhookSecret",
        j.template_id AS "templateId",
        j.default_args AS "defaultArgs",
        j.self_improve AS "selfImprove",
        j.continuation_enabled AS "continuationEnabled",
        j.max_iterations AS "maxIterations",
        j.completion_criteria AS "completionCriteria",
        j.recovery_instructions AS "recoveryInstructions",
        j.created_at AS "createdAt",
        j.updated_at AS "updatedAt",
        lr.id AS "lastRunId",
        lr.status AS "lastRunStatus",
        lr.started_at AS "lastRunStartedAt",
        lr.completed_at AS "lastRunCompletedAt",
        lr.duration_ms AS "lastRunDurationMs",
        lr.report AS "lastRunReport",
        EXISTS (SELECT 1 FROM job_runs pending WHERE pending.job_id = j.id AND pending.continuation_pending = TRUE) AS "continuationPending",
        lr.chain_id AS "lastRunChainId",
        lr.chain_iteration AS "lastRunIteration"
      FROM jobs j
      LEFT JOIN LATERAL (
        SELECT id, status, started_at, completed_at, duration_ms, report, continuation_pending, chain_id, chain_iteration
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

  async listRecentRuns(limit = 10): Promise<
    Array<{
      id: string;
      jobId: string;
      status: JobRunStatus;
      startedAt: string;
      durationMs: number | null;
      jobName: string;
    }>
  > {
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

  async getJobByWebhookSecret(secret: string): Promise<JobRecord | null> {
    const result = await this.pool.query(
      `SELECT ${this.jobColumns()} FROM jobs WHERE webhook_secret = $1 AND webhook_enabled = true`,
      [secret]
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async getJobByDirectoryAndName(
    directory: string,
    name: string
  ): Promise<JobRecord | null> {
    const result = await this.pool.query(
      `SELECT ${this.jobColumns()} FROM jobs WHERE directory = $1 AND name = $2`,
      [path.resolve(directory), name]
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async setEnabled(jobId: string, enabled: boolean): Promise<JobRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE jobs SET enabled = $2, updated_at = NOW()
         WHERE id = $1 RETURNING ${this.jobColumns()}`,
        [jobId, enabled]
      );
      if (!result.rows[0]) throw new Error(`Job ${jobId} not found.`);
      const updated = mapJob(result.rows[0]);
      await this.clearDisabledContinuationBarriers(client, updated);
      await client.query("COMMIT");
      return updated;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async updateJobConfig(
    jobId: string,
    input: JobConfigUpdate
  ): Promise<JobRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `
        UPDATE jobs
        SET name = COALESCE($2, name),
            prompt = CASE WHEN $3 THEN $4 ELSE prompt END,
            schedule = CASE WHEN $5 THEN $6 ELSE schedule END,
            timeout_ms = COALESCE($7, timeout_ms),
            needs_input_timeout_ms = COALESCE($8, needs_input_timeout_ms),
            agent_type = COALESCE($9, agent_type),
            model = CASE WHEN $10 THEN $11 ELSE model END,
            use_worktree = COALESCE($12, use_worktree),
            branch_name = CASE WHEN $13 THEN $14 ELSE branch_name END,
            full_access = COALESCE($15, full_access),
            enabled = COALESCE($16, enabled),
            base_branch = CASE WHEN $17 THEN $18 ELSE base_branch END,
            auto_archive = COALESCE($19, auto_archive),
            callable = COALESCE($20, callable),
            singleton = COALESCE($21, singleton),
            template_id = CASE WHEN $22 THEN $23 ELSE template_id END,
            default_args = CASE WHEN $24 THEN $25::jsonb ELSE default_args END,
            webhook_enabled = COALESCE($26, webhook_enabled),
            webhook_secret = CASE WHEN $27 THEN $28 ELSE webhook_secret END,
            self_improve = COALESCE($29, self_improve),
            continuation_enabled = COALESCE($30, continuation_enabled),
            max_iterations = CASE WHEN $31 THEN $32 ELSE max_iterations END,
            completion_criteria = CASE WHEN $33 THEN $34 ELSE completion_criteria END,
            recovery_instructions = CASE WHEN $35 THEN $36 ELSE recovery_instructions END,
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
          Object.prototype.hasOwnProperty.call(input, "model"),
          input.model ?? null,
          input.useWorktree,
          Object.prototype.hasOwnProperty.call(input, "branchName"),
          input.branchName ?? null,
          input.fullAccess,
          input.enabled,
          Object.prototype.hasOwnProperty.call(input, "baseBranch"),
          input.baseBranch ?? null,
          input.autoArchive,
          input.callable,
          input.singleton,
          Object.prototype.hasOwnProperty.call(input, "templateId"),
          input.templateId ?? null,
          Object.prototype.hasOwnProperty.call(input, "defaultArgs"),
          input.defaultArgs ? JSON.stringify(input.defaultArgs) : "{}",
          input.webhookEnabled,
          Object.prototype.hasOwnProperty.call(input, "webhookSecret"),
          input.webhookSecret ?? null,
          input.selfImprove,
          input.continuationEnabled,
          Object.prototype.hasOwnProperty.call(input, "maxIterations"),
          input.maxIterations ?? null,
          Object.prototype.hasOwnProperty.call(input, "completionCriteria"),
          input.completionCriteria ?? null,
          Object.prototype.hasOwnProperty.call(input, "recoveryInstructions"),
          input.recoveryInstructions ?? null,
        ]
      );
      if (!result.rows[0]) throw new Error(`Job ${jobId} not found.`);
      const updated = mapJob(result.rows[0]);
      await this.clearDisabledContinuationBarriers(client, updated);
      await client.query("COMMIT");
      return updated;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (isUniqueViolation(error)) {
        throw new Error(
          `A job named "${input.name}" already exists in this directory.`
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Caller holds the job-row lock; take run locks only after it. */
  private async clearDisabledContinuationBarriers(
    client: import("pg").PoolClient,
    job: JobRecord
  ): Promise<void> {
    if (job.enabled && job.continuationEnabled) return;
    await client.query(
      `UPDATE job_runs SET continuation_pending = FALSE
       WHERE job_id = $1 AND continuation_pending = TRUE`,
      [job.id]
    );
    await client.query(
      `UPDATE job_runs SET status = 'crashed', status_updated_at = NOW(),
         completed_at = NOW(), duration_ms = 0
       WHERE job_id = $1 AND status = 'started' AND agent_id IS NULL
         AND config->>'triggerSource' = 'continuation'`,
      [job.id]
    );
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
      throw new Error(
        `Job run ${runId} is no longer active (${existing.status}).`
      );
    }
    return mapRun(result.rows[0]);
  }

  private jobColumns(): string {
    return `
      id,
      directory,
      name,
      schedule,
      timeout_ms AS "timeoutMs",
      needs_input_timeout_ms AS "needsInputTimeoutMs",
      notify,
      prompt,
      enabled,
      agent_type AS "agentType",
      model,
      use_worktree AS "useWorktree",
      base_branch AS "baseBranch",
      branch_name AS "branchName",
      full_access AS "fullAccess",
      auto_archive AS "autoArchive",
      callable,
      singleton,
      webhook_enabled AS "webhookEnabled",
      webhook_secret AS "webhookSecret",
      template_id AS "templateId",
      default_args AS "defaultArgs",
      self_improve AS "selfImprove",
      continuation_enabled AS "continuationEnabled",
      max_iterations AS "maxIterations",
      completion_criteria AS "completionCriteria",
      recovery_instructions AS "recoveryInstructions",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    `;
  }

  private runColumns(table?: string): string {
    const prefix = table ? `${table}.` : "";
    return `
      ${prefix}id,
      ${prefix}job_id AS "jobId",
      ${prefix}agent_id AS "agentId",
      ${prefix}status,
      ${prefix}report,
      ${prefix}config,
      ${prefix}pending_question AS "pendingQuestion",
      ${prefix}started_at AS "startedAt",
      ${prefix}status_updated_at AS "statusUpdatedAt",
      ${prefix}completed_at AS "completedAt",
      ${prefix}duration_ms AS "durationMs",
      ${prefix}created_at AS "createdAt"
      ,${prefix}chain_id AS "chainId"
      ,${prefix}chain_iteration AS "chainIteration"
      ,${prefix}continuation
      ,${prefix}continuation_pending AS "continuationPending"
      ,${prefix}continuation_retries AS "continuationRetries"
    `;
  }
}

function validateContinuationStatus(value: unknown): ContinuationStatus | null {
  if (!value || typeof value !== "object" || !("continuation" in value))
    return null;
  const raw = (value as Record<string, unknown>).continuation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("report.continuation must be an object.");
  const valueRecord = raw as Record<string, unknown>;
  const action = valueRecord.action ?? "default";
  if (
    action !== "default" &&
    action !== "continue" &&
    action !== "pause" &&
    action !== "finish"
  )
    throw new Error(
      "report.continuation.action must be default, continue, pause, or finish."
    );
  const readString = (key: string, max = 4000): string | undefined => {
    const item = valueRecord[key];
    if (item === undefined) return undefined;
    if (typeof item !== "string" || !item.trim())
      throw new Error(`report.continuation.${key} must be a non-empty string.`);
    if (item.length > max)
      throw new Error(`report.continuation.${key} exceeds ${max} characters.`);
    return item.trim();
  };
  const readStrings = (key: string): string[] | undefined => {
    const item = valueRecord[key];
    if (item === undefined) return undefined;
    if (
      !Array.isArray(item) ||
      item.length > 50 ||
      item.some((v) => typeof v !== "string" || !v.trim() || v.length > 1000)
    )
      throw new Error(
        `report.continuation.${key} must contain at most 50 non-empty strings.`
      );
    return item.map((v) => v.trim());
  };
  return {
    action,
    phase: readString("phase", 200),
    summary: readString("summary"),
    nextIntent: readString("nextIntent"),
    filePaths: readStrings("filePaths"),
    blockers: readStrings("blockers"),
  };
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
