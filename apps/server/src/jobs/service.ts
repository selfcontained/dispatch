import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";
import { Cron } from "croner";

import type { AgentManager } from "../agents/manager.js";
import type { AppConfig } from "../config.js";
import { sanitizeAgentName } from "../shared/lib/agent-strings.js";
import { buildSelfImprovementGuidance } from "../shared/self-improvement-prompt.js";
import {
  applyAgentConfigDefaults,
  resolveAgentModelForUpdate,
} from "../shared/agent-models.js";
import { errorMessage } from "../shared/lib/error-message.js";
import { runCommand } from "../shared/lib/run-command.js";
import { sleep } from "../shared/lib/sleep.js";
import { normalizePath, resolveRepoRoot } from "../shared/git/git-context.js";
import { BrainStore } from "../brain/store.js";
import {
  JobStore,
  type AddJobInput,
  type JobAgentType,
  type JobRecord,
  type JobRunConfig,
  type JobRunRecord,
  type JobWithLatestRun,
} from "./store.js";
import {
  TemplateStore,
  substituteArgs,
  type TemplateRecord,
} from "../templates/store.js";
import { templateWorktreeConfig } from "../templates/worktree-config.js";
import {
  getNextRun,
  validateCronExpression,
  validateCronInterval,
} from "./cron.js";

export type JobRunCallback = (run: JobRunRecord) => void;

type RunJobInput = {
  name: string;
  directory: string;
  wait?: boolean;
  triggerSource?: "manual" | "scheduled" | "webhook" | "continuation";
  chainId?: string;
  iteration?: number;
  continuationOfRunId?: string;
  recoveryAttempt?: number;
};

export type { AddJobInput } from "./store.js";

export type RunJobResult = {
  jobId: string;
  runId: string;
  agentId: string;
  status: JobRunRecord["status"];
  report: JobRunRecord["report"];
};

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_NEEDS_INPUT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const TERMINAL_STATUSES = new Set<JobRunRecord["status"]>([
  "completed",
  "failed",
  "timed_out",
  "crashed",
]);
const ACTIVE_RUN_STATUSES = new Set<JobRunRecord["status"]>([
  "started",
  "running",
  "needs_input",
]);
const CODEX_FULL_ACCESS_ARG = "--dangerously-bypass-approvals-and-sandbox";
const CLAUDE_FULL_ACCESS_ARG = "--dangerously-skip-permissions";

export class JobService {
  private readonly store: JobStore;
  private readonly templateStore: TemplateStore;
  private readonly monitors = new Map<
    string,
    Promise<JobRunRecord | undefined>
  >();
  private readonly schedulers = new Map<string, Cron>();
  private readonly brainRetryTimers = new Map<
    string,
    { timer: NodeJS.Timeout | null; attempts: number; jobId: string }
  >();
  private readonly onRunStateChangeCallbacks: JobRunCallback[] = [];
  private stopping = false;

  constructor(
    pool: Pool,
    private readonly agentManager: AgentManager,
    private readonly logger: FastifyBaseLogger,
    private readonly config: AppConfig,
    private brainStore?: BrainStore
  ) {
    this.store = new JobStore(pool);
    this.templateStore = new TemplateStore(pool);
  }

  /** Register a callback that fires when a job run reaches a notable state. */
  onRunStateChange(cb: JobRunCallback): void {
    this.onRunStateChangeCallbacks.push(cb);
  }

  setBrainStore(brainStore: BrainStore): void {
    this.brainStore = brainStore;
  }

  getRuntimeMetrics(): { scheduledJobs: number; activeMonitors: number } {
    return {
      scheduledJobs: this.schedulers.size,
      activeMonitors: this.monitors.size,
    };
  }

  private emitRunStateChange(run: JobRunRecord): void {
    for (const cb of this.onRunStateChangeCallbacks) {
      try {
        cb(run);
      } catch (err) {
        this.logger.warn(
          { err, runId: run.id },
          "onRunStateChange callback error"
        );
      }
    }
  }

  async getJobById(jobId: string): Promise<JobRecord | null> {
    return this.store.getJob(jobId);
  }

  async getJobByName(
    directory: string,
    name: string
  ): Promise<JobRecord | null> {
    return this.store.getJobByDirectoryAndName(directory, name);
  }

  async runJob(input: RunJobInput): Promise<RunJobResult> {
    const job = await this.getJobOrThrow(input.directory, input.name);

    // Resolve agent config from backing template (fallback to job for legacy rows)
    const template = job.templateId
      ? await this.templateStore.getTemplate(job.templateId)
      : null;
    const agentConfig = template ?? job;
    const agentType = agentConfig.agentType as JobAgentType;

    const rawPrompt = agentConfig.prompt;
    if (!rawPrompt) {
      throw new Error(
        `Job "${job.name}" has no prompt configured. Add a prompt in the job settings.`
      );
    }

    // Substitute default args into prompt if the template has placeholders
    let resolvedPrompt: string;
    try {
      resolvedPrompt =
        template && Object.keys(job.defaultArgs).length > 0
          ? substituteArgs(rawPrompt, job.defaultArgs)
          : rawPrompt;
    } catch {
      resolvedPrompt = rawPrompt;
    }

    // createRun owns singleton/continuation admission under the job-row lock.
    let run = await this.store.createRun(
      job.id,
      buildRunConfig(
        job,
        input.triggerSource ?? "manual",
        input.chainId ?? (job.continuationEnabled ? randomUUID() : undefined),
        input.iteration ?? (job.continuationEnabled ? 1 : undefined),
        input.continuationOfRunId,
        input.recoveryAttempt
      )
    );
    this.emitRunStateChange(run);

    const jobLikeForPrompt = {
      ...job,
      prompt: resolvedPrompt,
      selfImprove: agentConfig.selfImprove,
    };
    const prompt = buildJobPrompt(jobLikeForPrompt, run);

    try {
      const agent = await this.agentManager.createAgent({
        name: `job-${sanitizeAgentName(job.name)}-${run.id.slice(0, 8)}`,
        type: agentType,
        model: agentConfig.model ?? undefined,
        cwd: job.directory,
        agentArgs: buildAgentArgs(agentType, prompt, agentConfig.fullAccess),
        // The CLI receives generated job-run scaffolding through agentArgs;
        // Chat shows only the user-authored job prompt.
        launchContext: { prompt: resolvedPrompt },
        fullAccess: agentConfig.fullAccess,
        ...templateWorktreeConfig(agentConfig),
        jobRunId: run.id,
      });
      run = await this.store.attachAgent(run.id, agent.id);
      this.emitRunStateChange(run);
      this.startMonitor(run.id);
      if (input.wait !== false) {
        run = await this.waitForTerminal(run.id);
      }
      return {
        jobId: job.id,
        runId: run.id,
        agentId: agent.id,
        status: run.status,
        report: run.report,
      };
    } catch (error) {
      const message = errorMessage(error);
      const crashed = await this.markCrashed(
        run,
        `Job failed to start: ${message}`,
        "spawn-agent"
      );
      if (crashed.continuationPending) {
        try {
          // No archive callback exists when agent creation itself failed.
          const recovered = await this.launchPendingContinuation(
            crashed.id,
            false
          );
          if (recovered) return recovered;
        } catch (recoveryError) {
          this.logger.warn(
            { err: recoveryError, runId: crashed.id },
            "Immediate continuation recovery launch failed"
          );
        }
      }
      throw new Error(`Job run ${crashed.id} failed to start: ${message}`);
    }
  }

  async runJobByWebhook(secret: string): Promise<RunJobResult> {
    const job = await this.store.getJobByWebhookSecret(secret);
    if (!job) throw new WebhookNotFoundError();
    return this.runJob({
      name: job.name,
      directory: job.directory,
      wait: false,
      triggerSource: "webhook",
    });
  }

  async reconcileActiveRuns(): Promise<void> {
    const runs = await this.store.listActiveRuns();
    for (const run of runs) {
      this.startMonitor(run.id);
    }
  }

  async listPendingContinuations(): Promise<JobRunRecord[]> {
    return this.store.listPendingContinuations();
  }

  async listReservedContinuationRuns(): Promise<JobRunRecord[]> {
    return this.store.listReservedContinuationRuns();
  }

  /** Resume a successor reservation left between row creation and attachment. */
  async recoverReservedContinuation(
    runId: string
  ): Promise<RunJobResult | null> {
    const run = await this.store.getRun(runId);
    if (
      !run ||
      run.status !== "started" ||
      run.agentId ||
      run.config.triggerSource !== "continuation"
    )
      return null;
    const job = await this.store.getJob(run.jobId);
    if (!job || !job.enabled || !job.continuationEnabled) return null;
    // createAgent can commit before a process dies. Its name carries the run
    // prefix, so reattach a live matching agent instead of creating a twin.
    const suffix = `-${run.id.slice(0, 8)}`;
    const existing = (await this.agentManager.listAgents()).find(
      (agent) =>
        agent.name.endsWith(suffix) &&
        ["creating", "running", "stopping"].includes(agent.status)
    );
    if (existing) {
      const attached = await this.store.attachAgent(run.id, existing.id);
      this.emitRunStateChange(attached);
      this.startMonitor(attached.id);
      return {
        jobId: job.id,
        runId: attached.id,
        agentId: existing.id,
        status: attached.status,
        report: attached.report,
      };
    }
    try {
      return await this.launchExistingRun(job, run, false);
    } catch (error) {
      await this.markCrashed(
        run,
        `Reserved continuation successor failed to launch: ${errorMessage(error)}`,
        "recover-reserved-successor",
        false
      );
      const predecessorId = run.config.continuationOfRunId;
      if (predecessorId) {
        const restored =
          await this.store.restorePendingContinuation(predecessorId);
        if (restored) {
          try {
            return await this.launchPendingContinuation(predecessorId, false);
          } catch {
            // launchPendingContinuation has paused the barrier after its one
            // allowed retry; retain the original launch error for diagnostics.
          }
        }
      }
      throw error;
    }
  }

  /** Called only after the terminal agent's archive completed successfully. */
  async launchPendingContinuation(
    runId: string,
    retrySuccessor = true
  ): Promise<RunJobResult | null> {
    const completed = await this.store.getRun(runId);
    if (!completed || !completed.continuationPending) {
      this.clearBrainRetry(runId);
      return null;
    }
    const job = await this.store.getJob(completed.jobId);
    if (!job || !job.enabled || !job.continuationEnabled) {
      this.clearBrainRetry(runId);
      return null;
    }
    // A failed sync must not interfere with terminal processing, but a
    // successor must never start before its durable handoff is available.
    try {
      await this.syncContinuationHandoff(completed);
      this.clearBrainRetry(runId);
    } catch (error) {
      this.scheduleBrainRetry(completed);
      throw error;
    }
    const recovery =
      (completed.status === "crashed" || completed.status === "timed_out") &&
      (completed.config.recoveryAttempt ?? 0) === 0;
    const config = buildRunConfig(
      job,
      "continuation",
      completed.chainId ?? randomUUID(),
      recovery
        ? (completed.chainIteration ?? 1)
        : (completed.chainIteration ?? 1) + 1,
      completed.id,
      recovery ? 1 : (completed.config.recoveryAttempt ?? 0),
      continuationBrainKey(job.id)
    );
    let handoff:
      | Awaited<ReturnType<JobStore["startPendingContinuation"]>>
      | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        handoff = await this.store.startPendingContinuation(runId, config);
        break;
      } catch (error) {
        if (attempt === 1) throw error;
        this.logger.warn(
          { err: error, runId },
          "Retrying continuation handoff"
        );
      }
    }
    if (!handoff) return null;
    try {
      return await this.launchExistingRun(job, handoff.successor, false);
    } catch (error) {
      // The started successor remains the barrier while it is marked crashed.
      await this.markCrashed(
        handoff.successor,
        `Continuation successor failed to launch: ${errorMessage(error)}`,
        "launch-successor",
        false
      );
      const restored = await this.store.restorePendingContinuation(runId);
      if (restored && retrySuccessor && restored.continuationRetries <= 1) {
        return await this.launchPendingContinuation(runId, false);
      }
      if (restored) await this.store.pausePendingContinuation(runId);
      throw error;
    }
  }

  async getActiveRunForAgent(agentId: string): Promise<JobRunRecord | null> {
    return await this.store.getActiveRunForAgent(agentId);
  }

  async getLatestRunForAgent(agentId: string): Promise<JobRunRecord | null> {
    return await this.store.getLatestRunForAgent(agentId);
  }

  async completeRunForAgent(
    agentId: string,
    report: unknown
  ): Promise<JobRunRecord> {
    const run = await this.store.completeRunForAgent(agentId, report);
    try {
      await this.syncContinuationHandoff(run);
    } catch (error) {
      // The pending barrier remains durable; launchPendingContinuation retries
      // the sync before starting a successor. Do not block notifications or
      // archiving after the terminal state has already been committed.
      this.logger.warn(
        { err: error, runId: run.id },
        "Continuation Brain handoff sync deferred"
      );
    }
    this.emitRunStateChange(run);
    return run;
  }

  private async launchExistingRun(
    job: JobRecord,
    run: JobRunRecord,
    wait: boolean
  ): Promise<RunJobResult> {
    const template = job.templateId
      ? await this.templateStore.getTemplate(job.templateId)
      : null;
    const agentConfig = template ?? job;
    if (!agentConfig.prompt)
      throw new Error(`Job "${job.name}" has no prompt configured.`);
    let resolvedPrompt = agentConfig.prompt;
    try {
      resolvedPrompt =
        template && Object.keys(job.defaultArgs).length > 0
          ? substituteArgs(agentConfig.prompt, job.defaultArgs)
          : agentConfig.prompt;
    } catch {
      // Keep a legacy/raw prompt launchable when arguments are incomplete.
    }
    const prompt = buildJobPrompt(
      {
        ...job,
        prompt: resolvedPrompt,
        selfImprove: agentConfig.selfImprove,
      },
      run
    );
    const agent = await this.agentManager.createAgent({
      name: `job-${sanitizeAgentName(job.name)}-${run.id.slice(0, 8)}`,
      type: agentConfig.agentType as JobAgentType,
      model: agentConfig.model ?? undefined,
      cwd: job.directory,
      agentArgs: buildAgentArgs(
        agentConfig.agentType as JobAgentType,
        prompt,
        agentConfig.fullAccess
      ),
      launchContext: { prompt: resolvedPrompt },
      fullAccess: agentConfig.fullAccess,
      ...templateWorktreeConfig(agentConfig),
      jobRunId: run.id,
    });
    const attached = await this.store.attachAgent(run.id, agent.id);
    this.emitRunStateChange(attached);
    this.startMonitor(attached.id);
    const terminal = wait ? await this.waitForTerminal(attached.id) : attached;
    return {
      jobId: job.id,
      runId: terminal.id,
      agentId: agent.id,
      status: terminal.status,
      report: terminal.report,
    };
  }

  private async syncContinuationHandoff(run: JobRunRecord): Promise<void> {
    if (!this.brainStore || !run.agentId) return;
    const job = await this.store.getJob(run.jobId);
    if (!job?.continuationEnabled) return;
    let repoRoot: string;
    try {
      repoRoot = await resolveRepoRoot(job.directory);
    } catch {
      // Brain is scoped by a stable repository root when possible; plain
      // directories are still valid job targets and use their normalized path.
      repoRoot = normalizePath(job.directory);
    }
    const key = continuationBrainKey(job.id);
    const terminalStatus =
      run.continuation?.action === "finish"
        ? "finished"
        : run.continuation?.action === "pause"
          ? "paused"
          : !run.continuationPending &&
              job.maxIterations != null &&
              (run.chainIteration ?? 1) >= job.maxIterations
            ? "capped"
            : (run.continuation?.action ?? "default");
    const value = {
      jobId: job.id,
      chainId: run.chainId,
      runId: run.id,
      iteration: run.chainIteration,
      status: terminalStatus,
      action: run.continuation?.action ?? "default",
      phase: run.continuation?.phase,
      summary: run.continuation?.summary ?? run.report?.summary ?? "",
      nextIntent: run.continuation?.nextIntent,
      filePaths: run.continuation?.filePaths ?? [],
      blockers: run.continuation?.blockers ?? [],
      recoveryAttempt: run.config.recoveryAttempt ?? 0,
      updatedAt: new Date().toISOString(),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const existing = await this.brainStore.getObject(
          repoRoot,
          "job-continuations",
          key
        );
        const existingValue = existing?.value as
          | {
              runId?: string;
              chainId?: string | null;
              iteration?: number | null;
            }
          | undefined;
        if (
          existingValue?.runId === run.id &&
          existingValue.chainId === run.chainId &&
          existingValue.iteration === run.chainIteration
        )
          return;
        await this.brainStore.storeObject(repoRoot, run.agentId, {
          collection: "job-continuations",
          name: key,
          value,
          expectedRevision: existing?.revision,
        });
        return;
      } catch (error) {
        if (attempt === 1) throw error;
      }
    }
  }

  async failRunForAgent(
    agentId: string,
    report: unknown
  ): Promise<JobRunRecord> {
    const run = await this.store.failRunForAgent(agentId, report);
    this.emitRunStateChange(run);
    return run;
  }

  async markNeedsInputForAgent(
    agentId: string,
    question: string
  ): Promise<JobRunRecord> {
    const run = await this.store.markNeedsInputForAgent(agentId, question);
    this.emitRunStateChange(run);
    return run;
  }

  async logForAgent(
    agentId: string,
    input: {
      task: string;
      message: string;
      level: "debug" | "info" | "warn" | "error";
    }
  ): Promise<JobRunRecord> {
    return await this.store.logForAgent(agentId, input);
  }

  async addJob(input: AddJobInput): Promise<JobRecord> {
    const displayName = input.displayName?.trim() || input.name;
    const schedule = input.schedule === "" ? null : (input.schedule ?? null);
    if (schedule && !validateCronExpression(schedule)) {
      throw new Error(
        `Job "${displayName}" has an invalid cron expression: "${schedule}"`
      );
    }
    if (input.enabled && !schedule && !input.continuationEnabled) {
      throw new Error(
        `Job "${displayName}" needs a schedule or continuation enabled before it can be enabled.`
      );
    }

    const agentConfig = applyAgentConfigDefaults(input);

    // Create a backing template for this job (hidden from Cmd+K by default).
    // If job creation fails, clean up the template to avoid orphans.
    const template = await this.templateStore.createTemplate({
      name: displayName,
      directory: input.directory,
      description: null,
      prompt: input.prompt ?? null,
      ...agentConfig,
      callable: false,
      allowMedia: false,
      selfImprove: input.selfImprove ?? false,
    });

    const webhookEnabled = input.webhookEnabled ?? false;
    const webhookSecret = webhookEnabled ? generateWebhookSecret() : null;

    let job: JobRecord;
    try {
      job = await this.store.createJob({
        name: displayName,
        directory: input.directory,
        prompt: input.prompt ?? null,
        schedule,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        needsInputTimeoutMs:
          input.needsInputTimeoutMs ?? DEFAULT_NEEDS_INPUT_TIMEOUT_MS,
        ...agentConfig,
        autoArchive: input.continuationEnabled
          ? true
          : (input.autoArchive ?? true),
        callable: input.callable ?? false,
        singleton: input.singleton ?? true,
        webhookEnabled,
        webhookSecret,
        templateId: template.id,
        defaultArgs: {},
        enabled: input.enabled ?? false,
        selfImprove: input.selfImprove ?? false,
        continuationEnabled: input.continuationEnabled ?? false,
        maxIterations: input.continuationEnabled
          ? input.maxIterations === undefined
            ? 10
            : input.maxIterations
          : (input.maxIterations ?? null),
        completionCriteria: input.completionCriteria ?? null,
        recoveryInstructions: input.recoveryInstructions ?? null,
      });
    } catch (error) {
      await this.templateStore
        .deleteTemplate(template.id)
        .catch((cleanupErr) =>
          this.logger.warn(
            { templateId: template.id, error: cleanupErr },
            "Failed to clean up orphaned template after job creation failure"
          )
        );
      throw error;
    }

    if (job.enabled && job.schedule) {
      this.scheduleJob(job);
    }
    this.logger.info({ jobId: job.id, name: job.name }, "Job added");
    return job;
  }

  async updateJob(input: AddJobInput): Promise<JobRecord> {
    const existing = await this.getJobOrThrow(input.directory, input.name);

    const schedule = input.schedule === "" ? null : input.schedule;
    const nextSchedule =
      input.schedule === undefined ? existing.schedule : schedule;
    if (nextSchedule && !validateCronExpression(nextSchedule)) {
      throw new Error(
        `Job "${input.displayName ?? existing.name}" has an invalid cron expression: "${nextSchedule}"`
      );
    }
    const nextContinuationEnabled =
      input.continuationEnabled ?? existing.continuationEnabled;
    if (input.enabled && !nextSchedule && !nextContinuationEnabled) {
      throw new Error(
        `Job "${input.displayName ?? existing.name}" needs a schedule or continuation enabled before it can be enabled.`
      );
    }

    const config: Parameters<JobStore["updateJobConfig"]>[1] = {};
    const displayName = normalizeOptionalString(input.displayName);
    const branchName = normalizeNullableString(input.branchName);
    const baseBranch = normalizeNullableString(input.baseBranch);
    if (displayName !== undefined && displayName !== existing.name) {
      const conflict = await this.store.getJobByDirectoryAndName(
        input.directory,
        displayName
      );
      if (conflict) {
        throw new Error(
          `A job named "${displayName}" already exists in directory "${input.directory}".`
        );
      }
      config.name = displayName;
    }
    if (input.prompt !== undefined) config.prompt = input.prompt;
    if (input.schedule !== undefined) config.schedule = schedule;
    if (input.timeoutMs !== undefined) config.timeoutMs = input.timeoutMs;
    if (input.needsInputTimeoutMs !== undefined)
      config.needsInputTimeoutMs = input.needsInputTimeoutMs;
    const nextModel = resolveAgentModelForUpdate({
      inputAgentType: input.agentType,
      inputModel: input.model,
      existingAgentType: existing.agentType,
      existingModel: existing.model,
    });
    if (input.agentType !== undefined) config.agentType = input.agentType;
    if (nextModel !== existing.model || input.model !== undefined)
      config.model = nextModel;
    if (input.useWorktree !== undefined) config.useWorktree = input.useWorktree;
    if (baseBranch !== undefined) config.baseBranch = baseBranch;
    if (branchName !== undefined) config.branchName = branchName;
    if (input.fullAccess !== undefined) config.fullAccess = input.fullAccess;
    if (nextContinuationEnabled) config.autoArchive = true;
    else if (input.autoArchive !== undefined)
      config.autoArchive = input.autoArchive;
    if (input.callable !== undefined) config.callable = input.callable;
    if (input.singleton !== undefined) config.singleton = input.singleton;
    if (input.webhookEnabled !== undefined) {
      config.webhookEnabled = input.webhookEnabled;
      if (input.webhookEnabled && !existing.webhookEnabled) {
        config.webhookSecret = generateWebhookSecret();
      } else if (!input.webhookEnabled) {
        config.webhookSecret = null;
      }
    }
    if (input.enabled !== undefined) config.enabled = input.enabled;
    if (input.selfImprove !== undefined) config.selfImprove = input.selfImprove;
    if (input.continuationEnabled !== undefined) {
      config.continuationEnabled = input.continuationEnabled;
      if (
        input.continuationEnabled &&
        !existing.continuationEnabled &&
        input.maxIterations === undefined
      )
        config.maxIterations = 10;
    }
    if (input.maxIterations !== undefined)
      config.maxIterations = input.maxIterations;
    if (input.completionCriteria !== undefined)
      config.completionCriteria = input.completionCriteria;
    if (input.recoveryInstructions !== undefined)
      config.recoveryInstructions = input.recoveryInstructions;

    const updated = await this.store.updateJobConfig(existing.id, config);
    if (!updated.enabled || !updated.continuationEnabled)
      this.clearBrainRetriesForJob(updated.id);

    // Propagate agent-config changes to the backing template
    if (updated.templateId) {
      const templateUpdates: Record<string, unknown> = {};
      if (input.prompt !== undefined) templateUpdates.prompt = input.prompt;
      if (input.agentType !== undefined)
        templateUpdates.agentType = input.agentType;
      if (config.model !== undefined) templateUpdates.model = config.model;
      if (input.useWorktree !== undefined)
        templateUpdates.useWorktree = input.useWorktree;
      if (input.baseBranch !== undefined)
        templateUpdates.baseBranch = input.baseBranch;
      if (input.branchName !== undefined)
        templateUpdates.branchName = input.branchName;
      if (input.fullAccess !== undefined)
        templateUpdates.fullAccess = input.fullAccess;
      if (input.selfImprove !== undefined)
        templateUpdates.selfImprove = input.selfImprove;
      if (displayName !== undefined && displayName !== existing.name) {
        templateUpdates.name = displayName;
      }
      if (Object.keys(templateUpdates).length > 0) {
        await this.templateStore
          .updateTemplate(
            updated.templateId,
            templateUpdates as Parameters<TemplateStore["updateTemplate"]>[1]
          )
          .catch((err) => {
            this.logger.warn(
              { err, templateId: updated.templateId },
              "Failed to propagate update to backing template"
            );
          });
      }
    }

    if (updated.enabled && updated.schedule) {
      this.scheduleJob(updated);
    } else {
      this.stopScheduler(updated.id);
    }
    this.logger.info(
      { jobId: updated.id, name: updated.name },
      "Job configuration updated"
    );
    return updated;
  }

  async enableJob(input: {
    name: string;
    directory: string;
  }): Promise<JobRecord> {
    const job = await this.getJobOrThrow(input.directory, input.name);
    const schedule = job.schedule;
    if (!schedule && !job.continuationEnabled) {
      throw new Error(
        `Job "${job.name}" has no schedule configured; enable continuation first.`
      );
    }
    if (schedule && !validateCronExpression(schedule)) {
      throw new Error(
        `Job "${job.name}" has an invalid cron expression: "${schedule}"`
      );
    }
    const intervalError = schedule ? validateCronInterval(schedule) : null;
    if (intervalError) {
      throw new Error(`Job "${job.name}": ${intervalError}`);
    }
    const updated = await this.store.setEnabled(job.id, true);
    this.scheduleJob(updated);
    this.logger.info(
      { jobId: updated.id, name: updated.name, schedule },
      "Job enabled with in-process scheduler"
    );
    return updated;
  }

  async disableJob(input: {
    name: string;
    directory: string;
  }): Promise<JobRecord> {
    const job = await this.getJobOrThrow(input.directory, input.name);
    const updated = await this.store.setEnabled(job.id, false);
    this.clearBrainRetriesForJob(updated.id);
    this.stopScheduler(updated.id);
    this.logger.info(
      { jobId: updated.id, name: updated.name },
      "Job disabled, scheduler stopped"
    );
    return updated;
  }

  async removeJob(input: {
    name: string;
    directory: string;
  }): Promise<JobRecord> {
    const job = await this.getJobOrThrow(input.directory, input.name);
    this.clearBrainRetriesForJob(job.id);
    const activeRun = await this.store.findActiveRun(job.id);
    if (activeRun) {
      throw new Error(
        `Job "${job.name}" has active run ${activeRun.id} (${activeRun.status}). Stop or complete the run before removing it.`
      );
    }
    this.stopScheduler(job.id);
    const removed = await this.store.deleteJob(job.id);

    // Clean up the backing template if no other jobs reference it
    if (removed.templateId) {
      const hasOtherJobs = await this.templateStore.hasJobsReferencing(
        removed.templateId
      );
      if (!hasOtherJobs) {
        await this.templateStore
          .deleteTemplate(removed.templateId)
          .catch((err) => {
            this.logger.warn(
              { err, templateId: removed.templateId },
              "Failed to clean up backing template"
            );
          });
      }
    }

    this.logger.info(
      { jobId: removed.id, name: removed.name },
      "Job removed from configuration"
    );
    return removed;
  }

  async listJobs(): Promise<
    Array<JobWithLatestRun & { nextRun: string | null }>
  > {
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

  async listRunsForJob(input: {
    name: string;
    directory: string;
    limit?: number;
  }): Promise<{
    job: JobRecord;
    runs: JobRunRecord[];
  }> {
    const job = await this.getJobOrThrow(input.directory, input.name);
    const runs = await this.store.listRunsForJob(job.id, input.limit ?? 20);
    return { job, runs };
  }

  async getStats(): Promise<{
    stats: {
      totalRuns: number;
      successCount: number;
      failureCount: number;
      avgDurationMs: number | null;
      daily: Array<{ day: string; completed: number; failed: number }>;
    };
    recentRuns: Array<{
      id: string;
      jobId: string;
      status: string;
      startedAt: string;
      durationMs: number | null;
      jobName: string;
    }>;
  }> {
    const [stats, recentRuns] = await Promise.all([
      this.store.getRunStats(7),
      this.store.listRecentRuns(30),
    ]);
    return { stats, recentRuns };
  }

  /** Look up a job by name + directory, or throw if not found. */
  private async getJobOrThrow(
    directory: string,
    name: string
  ): Promise<JobRecord> {
    const job = await this.store.getJobByDirectoryAndName(directory, name);
    if (!job) {
      throw new Error(`Job "${name}" not found in directory "${directory}".`);
    }
    return job;
  }

  /** Load all enabled jobs from DB and start their in-process schedulers. Called on server startup. */
  async startSchedulers(): Promise<void> {
    const jobs = await this.store.listJobs();
    for (const job of jobs) {
      if (job.enabled && job.schedule) {
        this.scheduleJob(job);
      }
    }
    this.logger.info(
      { count: this.schedulers.size },
      "Started in-process schedulers for enabled jobs"
    );
  }

  /** Stop all in-process schedulers and signal monitors to exit. */
  stopAllSchedulers(): void {
    this.stopping = true;
    for (const cron of this.schedulers.values()) {
      cron.stop();
    }
    this.schedulers.clear();
    for (const { timer } of this.brainRetryTimers.values()) {
      if (timer) clearTimeout(timer);
    }
    this.brainRetryTimers.clear();
  }

  /** Stop schedulers and wait for all in-flight monitors to finish. */
  async shutdown(): Promise<void> {
    this.stopAllSchedulers();
    const pending = [...this.monitors.values()];
    await Promise.allSettled(pending);
  }

  private scheduleBrainRetry(run: JobRunRecord): void {
    if (!run.continuationPending || this.stopping) return;
    const existing = this.brainRetryTimers.get(run.id);
    if (existing?.timer) return;
    const attempts = (existing?.attempts ?? 0) + 1;
    const delayMs = Math.min(30_000, 1_000 * 2 ** (attempts - 1));
    const entry = existing ?? { timer: null, attempts: 0, jobId: run.jobId };
    entry.attempts = attempts;
    entry.jobId = run.jobId;
    entry.timer = setTimeout(async () => {
      entry.timer = null;
      try {
        await this.launchPendingContinuation(run.id);
      } catch (error) {
        this.logger.warn(
          { err: error, runId: run.id, attempts: entry.attempts },
          "Retrying deferred continuation Brain handoff failed"
        );
      }
    }, delayMs);
    this.brainRetryTimers.set(run.id, entry);
  }

  private clearBrainRetry(runId: string): void {
    const entry = this.brainRetryTimers.get(runId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.brainRetryTimers.delete(runId);
  }

  private clearBrainRetriesForJob(jobId: string): void {
    for (const [runId, entry] of this.brainRetryTimers) {
      if (entry.jobId === jobId) this.clearBrainRetry(runId);
    }
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

        await this.runJob({
          name: current.name,
          directory: current.directory,
          wait: false,
          triggerSource: "scheduled",
        });
      } catch (err) {
        this.logger.error({ err, jobId }, "Scheduled job run failed");
      }
    });

    this.schedulers.set(jobId, cronJob);
    this.logger.info(
      { jobId, name: job.name, schedule: job.schedule },
      "In-process scheduler started"
    );
  }

  private stopScheduler(jobId: string): void {
    const existing = this.schedulers.get(jobId);
    if (existing) {
      existing.stop();
      this.schedulers.delete(jobId);
    }
  }

  private startMonitor(runId: string): void {
    if (this.stopping || this.monitors.has(runId)) return;
    const monitor = this.monitorRun(runId)
      .catch(async (error) => {
        if (this.stopping) return;
        this.logger.warn({ err: error, runId }, "Job monitor failed.");
        const run = await this.store.getRun(runId);
        if (run && ACTIVE_RUN_STATUSES.has(run.status)) {
          return await this.markCrashed(run, errorMessage(error));
        }
        if (run) return run;
      })
      .finally(() => {
        this.monitors.delete(runId);
      });
    this.monitors.set(runId, monitor);
  }

  private async waitForTerminal(runId: string): Promise<JobRunRecord> {
    const monitor = this.monitors.get(runId);
    if (monitor) {
      const result = await monitor;
      if (result) return result;
    }
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
        return await this.markTimedOut(
          current,
          "Job execution timeout elapsed before the agent reported completion."
        );
      }
      if (
        current.status === "needs_input" &&
        now - statusUpdatedAt >= current.config.needsInputTimeoutMs
      ) {
        return await this.markTimedOut(
          current,
          "Job timed out waiting for human input."
        );
      }
      if (
        current.agentId &&
        (await this.agentSessionCrashed(current.agentId))
      ) {
        return await this.markCrashed(
          current,
          "Agent session ended before reporting a terminal job state."
        );
      }
      await sleep(2_000);
      if (this.stopping) break;
      const refreshed = await this.store.getRun(runId);
      if (!refreshed) throw new Error(`Job run ${runId} disappeared.`);
      current = refreshed;
    }

    if (!TERMINAL_STATUSES.has(current.status)) {
      this.logger.warn(
        { runId, status: current.status },
        "Job monitor stopped on unexpected status."
      );
    }
    return current;
  }

  private async agentSessionCrashed(agentId: string): Promise<boolean> {
    const agent = await this.agentManager.getAgent(agentId);
    if (!agent) return true;
    if (agent.status === "error" || agent.status === "stopped") return true;
    if (this.config.agentRuntime === "inert") return false;
    if (!agent.tmuxSession) return false;
    const tmux = await runCommand(
      "tmux",
      ["has-session", "-t", agent.tmuxSession],
      { allowedExitCodes: [0, 1] }
    );
    return tmux.exitCode !== 0;
  }

  private async markTimedOut(
    run: JobRunRecord,
    message: string
  ): Promise<JobRunRecord> {
    const updated = await this.store.markTimedOut(run.id, {
      status: "failed",
      summary: message,
      tasks: [
        {
          name: "guardrails",
          status: "error",
          summary: "The job runner timed out the execution.",
          errors: [
            {
              message,
              recoverable: true,
              action: "Inspect the agent session and rerun when ready.",
            },
          ],
        },
      ],
    });
    return await this.scheduleInfrastructureRecovery(updated);
  }

  private async markCrashed(
    run: JobRunRecord,
    message: string,
    taskName = "guardrails",
    scheduleRecovery = true
  ): Promise<JobRunRecord> {
    const diagnostics = run.agentId
      ? await this.readAgentDiagnostics(run.agentId)
      : "";
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
          errors: [
            {
              message: fullMessage,
              recoverable: true,
              action: "Review the agent terminal logs and rerun the job.",
            },
          ],
        },
      ],
    });
    return scheduleRecovery
      ? await this.scheduleInfrastructureRecovery(updated)
      : (this.emitRunStateChange(updated), updated);
  }

  private async scheduleInfrastructureRecovery(
    run: JobRunRecord
  ): Promise<JobRunRecord> {
    const recovery = await this.store.scheduleRecovery(run.id);
    const updated = recovery ?? run;
    this.emitRunStateChange(updated);
    return updated;
  }

  private async readAgentDiagnostics(agentId: string): Promise<string> {
    const sections: string[] = [];
    const setupLog = await readFile(
      `/tmp/dispatch_setup_${agentId}.log`,
      "utf8"
    ).catch(() => "");
    if (setupLog.trim()) {
      sections.push(
        `Setup log tail:\n${setupLog.trim().split("\n").slice(-20).join("\n")}`
      );
    }

    const agent = await this.agentManager.getAgent(agentId);
    if (agent?.tmuxSession) {
      const pane = await runCommand(
        "tmux",
        ["capture-pane", "-pt", agent.tmuxSession],
        { allowedExitCodes: [0, 1] }
      );
      if (pane.exitCode === 0 && pane.stdout.trim()) {
        sections.push(
          `Terminal pane tail:\n${pane.stdout.trim().split("\n").slice(-40).join("\n")}`
        );
      }
    }

    return sections.join("\n\n");
  }
}

function buildAgentArgs(
  agentType: JobRecord["agentType"],
  prompt: string,
  fullAccess: boolean
): string[] {
  const args = ["--append-system-prompt", prompt];
  const fullAccessArg =
    agentType === "claude"
      ? CLAUDE_FULL_ACCESS_ARG
      : agentType === "codex"
        ? CODEX_FULL_ACCESS_ARG
        : null;
  if (fullAccess && fullAccessArg) args.push(fullAccessArg);
  if (agentType === "claude") {
    // Claude Code needs a positional prompt arg to start an interactive session
    // with an initial message. Without it the agent sits idle waiting for input.
    args.push("Run the job described in your system prompt now.");
  }
  return args;
}

function buildRunConfig(
  job: JobRecord,
  triggerSource: "manual" | "scheduled" | "webhook" | "continuation",
  chainId?: string,
  iteration?: number,
  continuationOfRunId?: string,
  recoveryAttempt?: number,
  previousHandoffKey?: string
): JobRunConfig {
  return {
    directory: job.directory,
    name: job.name,
    schedule: job.schedule,
    timeoutMs: job.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    needsInputTimeoutMs:
      job.needsInputTimeoutMs ?? DEFAULT_NEEDS_INPUT_TIMEOUT_MS,
    notify: job.notify ?? { onComplete: [], onError: [], onNeedsInput: [] },
    triggerSource,
    autoArchive: job.autoArchive,
    continuationEnabled: job.continuationEnabled,
    maxIterations: job.maxIterations,
    chainId,
    iteration,
    continuationOfRunId,
    recoveryAttempt,
    previousHandoffKey,
  };
}

function buildJobPrompt(job: JobRecord, run: JobRunRecord): string {
  return [
    "You are running as a Dispatch Job agent.",
    `Job ID: ${job.id}`,
    `Run ID: ${run.id}`,
    "Use the job-specific MCP tools for lifecycle control.",
    "Call job_log for task-level progress.",
    "Call exactly one terminal tool before stopping: job_complete(report), job_failed(report), or job_needs_input(question).",
    "Terminal completed/failed states must include a structured report with status, summary, and tasks.",
    ...(job.continuationEnabled
      ? [
          "This is a Loop job. Before completing the run, call job_complete with continuation { action: continue|pause|finish, phase, summary, nextIntent, filePaths, blockers }.",
          "When another run should start, nextIntent is required. Keep detailed context in the locations defined by the job prompt; filePaths should identify only the files relevant to the next run.",
          `Completion criteria:\n${formatCompletionCriteria(job.completionCriteria)}`,
          `Recovery instructions: ${job.recoveryInstructions ?? "Not specified."}`,
          ...(run.config.triggerSource === "continuation"
            ? [
                `Continuation chain: ${run.chainId ?? "unknown"}; iteration: ${run.chainIteration ?? "unknown"}; previous run: ${run.config.continuationOfRunId ?? "unknown"}.`,
                `Previous compact handoff Brain object: job-continuations/${run.config.previousHandoffKey ?? continuationBrainKey(job.id)}. Read repository handoff files and the durable previous run handoff; do not expect a report in this prompt.`,
                `Recovery attempt: ${run.config.recoveryAttempt ?? 0}.`,
              ]
            : []),
        ]
      : []),
    "Use repo tools when they are relevant to the job.",
    "\nJob prompt:",
    job.prompt!,
    ...(job.selfImprove
      ? [
          buildSelfImprovementGuidance({
            kind: "job",
            name: job.name,
            directory: job.directory,
          }),
        ]
      : []),
  ].join("\n");
}

function continuationBrainKey(jobId: string): string {
  return `job-${jobId}`;
}

function formatCompletionCriteria(
  criteria: string[] | null | undefined
): string {
  if (!criteria?.length) return "Not specified.";
  return criteria.map((criterion) => `- ${criterion}`).join("\n");
}

function normalizeOptionalString(
  value: string | undefined
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export class WebhookNotFoundError extends Error {
  constructor() {
    super("Webhook not found or disabled.");
    this.name = "WebhookNotFoundError";
  }
}

function generateWebhookSecret(): string {
  return randomBytes(24).toString("base64url");
}

function normalizeNullableString(
  value: string | null | undefined
): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
