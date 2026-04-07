import { readFile } from "node:fs/promises";

import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";
import { Cron } from "croner";

import type { AgentManager } from "../agents/manager.js";
import type { AppConfig } from "../config.js";
import { runCommand } from "@dispatch/shared/lib/run-command.js";
import { readJobDefinition, jobFilePath } from "./parser.js";
import { JobStore, type JobRecord, type JobRunConfig, type JobRunRecord, type JobWithLatestRun } from "./store.js";
import { getNextRun, validateCronExpression } from "./cron.js";

export type JobRunCallback = (run: JobRunRecord) => void;

type RunJobInput = {
  name: string;
  directory: string;
  wait?: boolean;
};

export type RunJobResult = {
  jobId: string;
  runId: string;
  agentId: string;
  status: JobRunRecord["status"];
  report: JobRunRecord["report"];
};

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_NEEDS_INPUT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const TERMINAL_STATUSES = new Set<JobRunRecord["status"]>(["completed", "failed", "timed_out", "crashed"]);
const ACTIVE_RUN_STATUSES = new Set<JobRunRecord["status"]>(["started", "running", "needs_input"]);
const CODEX_FULL_ACCESS_ARG = "--dangerously-bypass-approvals-and-sandbox";
const CLAUDE_FULL_ACCESS_ARG = "--dangerously-skip-permissions";

export class JobService {
  private readonly store: JobStore;
  private readonly monitors = new Map<string, Promise<JobRunRecord>>();
  private readonly schedulers = new Map<string, Cron>();
  private readonly onRunStateChangeCallbacks: JobRunCallback[] = [];
  private stopping = false;

  constructor(
    pool: Pool,
    private readonly agentManager: AgentManager,
    private readonly logger: FastifyBaseLogger,
    private readonly config: AppConfig
  ) {
    this.store = new JobStore(pool);
  }

  /** Register a callback that fires when a job run reaches a notable state. */
  onRunStateChange(cb: JobRunCallback): void {
    this.onRunStateChangeCallbacks.push(cb);
  }

  private emitRunStateChange(run: JobRunRecord): void {
    for (const cb of this.onRunStateChangeCallbacks) {
      try {
        cb(run);
      } catch (err) {
        this.logger.warn({ err, runId: run.id }, "onRunStateChange callback error");
      }
    }
  }

  async runJob(input: RunJobInput): Promise<RunJobResult> {
    // Pre-execute: sync file → DB if the file exists
    const job = await this.syncJobFromFile(input.directory, input.name);

    if (!job.prompt) {
      throw new Error(`Job "${job.name}" has no prompt configured. Add a prompt to the job file or configure it in the UI.`);
    }

    // Pre-check for user-friendly error message. The DB unique index
    // (idx_job_runs_one_active_per_job) is the real guard against concurrent races.
    const activeRun = await this.store.findActiveRun(job.id);
    if (activeRun) {
      throw new Error(`Job "${job.name}" already has active run ${activeRun.id} (${activeRun.status}).`);
    }

    // Everything below reads from the DB record only
    let run = await this.store.createRun(job.id, buildRunConfig(job));
    const prompt = buildJobPrompt(job, run.id);

    try {
      const agent = await this.agentManager.createAgent({
        name: `job-${sanitizeAgentName(job.name)}-${run.id.slice(0, 8)}`,
        type: job.agentType,
        cwd: job.directory,
        agentArgs: buildAgentArgs(job.agentType, prompt, job.fullAccess),
        fullAccess: job.fullAccess,
        useWorktree: job.useWorktree,
        worktreeBranch: job.branchName ?? undefined,
        jobRunId: run.id
      });
      run = await this.store.attachAgent(run.id, agent.id);
      this.startMonitor(run.id);
      if (input.wait !== false) {
        run = await this.waitForTerminal(run.id);
      }
      return {
        jobId: job.id,
        runId: run.id,
        agentId: agent.id,
        status: run.status,
        report: run.report
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const crashed = await this.markCrashed(run, `Job failed to start: ${message}`, "spawn-agent");
      throw new Error(`Job run ${crashed.id} failed to start: ${message}`);
    }
  }

  async reconcileActiveRuns(): Promise<void> {
    const runs = await this.store.listActiveRuns();
    for (const run of runs) {
      this.startMonitor(run.id);
    }
  }

  async getActiveRunForAgent(agentId: string): Promise<JobRunRecord | null> {
    return await this.store.getActiveRunForAgent(agentId);
  }

  async getLatestRunForAgent(agentId: string): Promise<JobRunRecord | null> {
    return await this.store.getLatestRunForAgent(agentId);
  }

  async completeRunForAgent(agentId: string, report: unknown): Promise<JobRunRecord> {
    const run = await this.store.completeRunForAgent(agentId, report);
    this.monitors.delete(run.id);
    this.emitRunStateChange(run);
    return run;
  }

  async failRunForAgent(agentId: string, report: unknown): Promise<JobRunRecord> {
    const run = await this.store.failRunForAgent(agentId, report);
    this.monitors.delete(run.id);
    this.emitRunStateChange(run);
    return run;
  }

  async markNeedsInputForAgent(agentId: string, question: string): Promise<JobRunRecord> {
    const run = await this.store.markNeedsInputForAgent(agentId, question);
    this.emitRunStateChange(run);
    return run;
  }

  async logForAgent(
    agentId: string,
    input: { task: string; message: string; level: "debug" | "info" | "warn" | "error" }
  ): Promise<JobRunRecord> {
    return await this.store.logForAgent(agentId, input);
  }

  async enableJob(input: { name: string; directory: string }): Promise<JobRecord> {
    const job = await this.syncJobFromFile(input.directory, input.name);
    const schedule = job.schedule;
    if (!schedule) {
      throw new Error(`Job "${job.name}" has no schedule configured.`);
    }
    if (!validateCronExpression(schedule)) {
      throw new Error(`Job "${job.name}" has an invalid cron expression: "${schedule}"`);
    }
    const updated = await this.store.setEnabled(job.id, true);
    this.scheduleJob(updated);
    this.logger.info({ jobId: updated.id, name: updated.name, schedule }, "Job enabled with in-process scheduler");
    return updated;
  }

  async disableJob(input: { name: string; directory: string }): Promise<JobRecord> {
    const job = await this.syncJobFromFile(input.directory, input.name);
    const updated = await this.store.setEnabled(job.id, false);
    this.stopScheduler(updated.id);
    this.logger.info({ jobId: updated.id, name: updated.name }, "Job disabled, scheduler stopped");
    return updated;
  }

  async listJobs(): Promise<Array<JobWithLatestRun & { nextRun: string | null }>> {
    const jobs = await this.store.listJobs();
    return jobs.map((job) => {
      let nextRun: string | null = null;
      if (job.enabled && job.schedule) {
        const next = getNextRun(job.schedule);
        if (next) nextRun = next.toISOString();
      }
      return { ...job, nextRun };
    });
  }

  async listRunsForJob(input: { name: string; directory: string; limit?: number }): Promise<{
    job: JobRecord;
    runs: JobRunRecord[];
  }> {
    const job = await this.store.getJobByDirectoryAndFilePath(input.directory, jobFilePath(input.directory, input.name));
    if (!job) throw new Error(`Job "${input.name}" not found in directory "${input.directory}".`);
    const runs = await this.store.listRunsForJob(job.id, input.limit ?? 20);
    return { job, runs };
  }

  /**
   * Pre-execute step: try to read the job file and upsert the DB record
   * (refreshes prompt and file_path only). If the file is missing, returns
   * the existing DB record. Throws if neither source exists.
   */
  private async syncJobFromFile(directory: string, name: string): Promise<JobRecord> {
    try {
      const definition = await readJobDefinition(directory, name);
      return await this.store.upsertJobFromDefinition(definition);
    } catch (err) {
      // Only fall back to DB when the file is missing. Let DB errors and parse errors propagate.
      if (!isFileNotFound(err)) throw err;
      const existing = await this.store.getJobByDirectoryAndFilePath(directory, jobFilePath(directory, name));
      if (!existing) {
        throw new Error(`Job "${name}" not found in directory "${directory}" and no job file exists.`);
      }
      this.logger.info({ jobName: name, directory }, "Job file not found, using stored configuration");
      return existing;
    }
  }

  /** Load all enabled jobs from DB and start their in-process schedulers. Called on server startup. */
  async startSchedulers(): Promise<void> {
    const jobs = await this.store.listJobs();
    for (const job of jobs) {
      if (job.enabled && job.schedule) {
        this.scheduleJob(job);
      }
    }
    this.logger.info({ count: this.schedulers.size }, "Started in-process schedulers for enabled jobs");
  }

  /** Stop all in-process schedulers and signal monitors to exit. Called on server shutdown. */
  stopAllSchedulers(): void {
    this.stopping = true;
    for (const cron of this.schedulers.values()) {
      cron.stop();
    }
    this.schedulers.clear();
  }

  private scheduleJob(job: JobRecord): void {
    this.stopScheduler(job.id);
    if (!job.schedule) return;

    const jobId = job.id;
    const cronJob = new Cron(job.schedule, async () => {
      try {
        // Look up current job record from DB — name/directory may have changed since scheduling
        const current = await this.store.getJob(jobId);
        if (!current || !current.enabled) return;

        const activeRun = await this.store.findActiveRun(jobId);
        if (activeRun) {
          this.logger.info(
            { jobId, name: current.name, activeRunId: activeRun.id },
            "Skipping scheduled run — job already has an active run"
          );
          return;
        }
        await this.runJob({ name: current.name, directory: current.directory, wait: false });
      } catch (err) {
        this.logger.error({ err, jobId }, "Scheduled job run failed");
      }
    });

    this.schedulers.set(jobId, cronJob);
    this.logger.info({ jobId, name: job.name, schedule: job.schedule }, "In-process scheduler started");
  }

  private stopScheduler(jobId: string): void {
    const existing = this.schedulers.get(jobId);
    if (existing) {
      existing.stop();
      this.schedulers.delete(jobId);
    }
  }

  private startMonitor(runId: string): void {
    if (this.monitors.has(runId)) return;
    const monitor = this.monitorRun(runId)
      .catch(async (error) => {
        this.logger.warn({ err: error, runId }, "Job monitor failed.");
        const run = await this.store.getRun(runId);
        if (run && ACTIVE_RUN_STATUSES.has(run.status)) {
          return await this.markCrashed(run, error instanceof Error ? error.message : String(error));
        }
        if (run) return run;
        throw error;
      })
      .finally(() => {
        this.monitors.delete(runId);
      });
    this.monitors.set(runId, monitor);
  }

  private async waitForTerminal(runId: string): Promise<JobRunRecord> {
    const monitor = this.monitors.get(runId);
    if (monitor) return await monitor;
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`Job run ${runId} not found.`);
    return run;
  }

  private async monitorRun(runId: string): Promise<JobRunRecord> {
    let current = await this.store.getRun(runId);
    if (!current) throw new Error(`Job run ${runId} not found.`);

    while (ACTIVE_RUN_STATUSES.has(current.status) && !this.stopping) {
      const now = Date.now();
      const startedAt = new Date(current.startedAt).getTime();
      const statusUpdatedAt = new Date(current.statusUpdatedAt).getTime();
      if (now - startedAt >= current.config.timeoutMs) {
        return await this.markTimedOut(current, "Job execution timeout elapsed before the agent reported completion.");
      }
      if (current.status === "needs_input" && now - statusUpdatedAt >= current.config.needsInputTimeoutMs) {
        return await this.markTimedOut(current, "Job timed out waiting for human input.");
      }
      if (current.agentId && await this.agentSessionCrashed(current.agentId)) {
        return await this.markCrashed(current, "Agent session ended before reporting a terminal job state.");
      }
      await sleep(2_000);
      const refreshed = await this.store.getRun(runId);
      if (!refreshed) throw new Error(`Job run ${runId} disappeared.`);
      current = refreshed;
    }

    if (!TERMINAL_STATUSES.has(current.status)) {
      this.logger.warn({ runId, status: current.status }, "Job monitor stopped on unexpected status.");
    }
    return current;
  }

  private async agentSessionCrashed(agentId: string): Promise<boolean> {
    const agent = await this.agentManager.getAgent(agentId);
    if (!agent) return true;
    if (agent.status === "error" || agent.status === "stopped") return true;
    if (this.config.agentRuntime === "inert") return false;
    if (!agent.tmuxSession) return false;
    const tmux = await runCommand("tmux", ["has-session", "-t", agent.tmuxSession], { allowedExitCodes: [0, 1] });
    return tmux.exitCode !== 0;
  }

  private async markTimedOut(run: JobRunRecord, message: string): Promise<JobRunRecord> {
    const updated = await this.store.markTimedOut(run.id, {
      status: "failed",
      summary: message,
      tasks: [
        {
          name: "guardrails",
          status: "error",
          summary: "The job runner timed out the execution.",
          errors: [{ message, recoverable: true, action: "Inspect the agent session and rerun when ready." }]
        }
      ]
    });
    this.emitRunStateChange(updated);
    return updated;
  }

  private async markCrashed(run: JobRunRecord, message: string, taskName = "guardrails"): Promise<JobRunRecord> {
    const diagnostics = run.agentId ? await this.readAgentDiagnostics(run.agentId) : "";
    const fullMessage = diagnostics ? `${message}\n\n${diagnostics}` : message;
    this.logger.warn({ runId: run.id, agentId: run.agentId }, message);
    const updated = await this.store.markCrashed(run.id, {
      status: "failed",
      summary: message,
      tasks: [
        {
          name: taskName,
          status: "error",
          summary: "The job runner detected an agent crash.",
          errors: [{ message: fullMessage, recoverable: true, action: "Review the agent terminal logs and rerun the job." }]
        }
      ]
    });
    this.emitRunStateChange(updated);
    return updated;
  }

  private async readAgentDiagnostics(agentId: string): Promise<string> {
    const sections: string[] = [];
    const setupLog = await readFile(`/tmp/dispatch_setup_${agentId}.log`, "utf8").catch(() => "");
    if (setupLog.trim()) {
      sections.push(`Setup log tail:\n${setupLog.trim().split("\n").slice(-20).join("\n")}`);
    }

    const agent = await this.agentManager.getAgent(agentId);
    if (agent?.tmuxSession) {
      const pane = await runCommand("tmux", ["capture-pane", "-pt", agent.tmuxSession], { allowedExitCodes: [0, 1] });
      if (pane.exitCode === 0 && pane.stdout.trim()) {
        sections.push(`Terminal pane tail:\n${pane.stdout.trim().split("\n").slice(-40).join("\n")}`);
      }
    }

    return sections.join("\n\n");
  }
}

function buildAgentArgs(agentType: JobRecord["agentType"], prompt: string, fullAccess: boolean): string[] {
  const args = ["--append-system-prompt", prompt];
  const fullAccessArg =
    agentType === "claude"
      ? CLAUDE_FULL_ACCESS_ARG
      : agentType === "codex"
        ? CODEX_FULL_ACCESS_ARG
        : null;
  return fullAccess && fullAccessArg ? [...args, fullAccessArg] : args;
}

function buildRunConfig(job: JobRecord): JobRunConfig {
  return {
    directory: job.directory,
    filePath: job.filePath ?? "",
    name: job.name,
    schedule: job.schedule,
    timeoutMs: job.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    needsInputTimeoutMs: job.needsInputTimeoutMs ?? DEFAULT_NEEDS_INPUT_TIMEOUT_MS,
    notify: job.notify ?? { onComplete: [], onError: [], onNeedsInput: [] },
  };
}

function buildJobPrompt(job: JobRecord, runId: string): string {
  const additional = job.additionalInstructions?.trim()
    ? `\n\nAdditional server-side instructions:\n${job.additionalInstructions.trim()}`
    : "";
  return [
    "You are running as a Dispatch Job agent.",
    `Job ID: ${job.id}`,
    `Run ID: ${runId}`,
    "Use the job-specific MCP tools for lifecycle control.",
    "Call job_log for task-level progress.",
    "Call exactly one terminal tool before stopping: job_complete(report), job_failed(report), or job_needs_input(question).",
    "Terminal completed/failed states must include a structured report with status, summary, and tasks.",
    "Use repo tools when they are relevant to the job.",
    additional,
    "\nJob prompt:",
    job.prompt!
  ].filter(Boolean).join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeAgentName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
}

function isFileNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "ENOENT";
}
