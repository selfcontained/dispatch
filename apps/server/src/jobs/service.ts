import { readFile } from "node:fs/promises";

import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import type { AgentManager } from "../agents/manager.js";
import type { AppConfig } from "../config.js";
import { runCommand } from "@dispatch/shared/lib/run-command.js";
import type { JobDefinition } from "./parser.js";
import { readJobDefinition } from "./parser.js";
import { JobStore, type JobRecord, type JobRunConfig, type JobRunRecord } from "./store.js";

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

const TERMINAL_STATUSES = new Set<JobRunRecord["status"]>(["completed", "failed", "timed_out", "crashed"]);
const ACTIVE_RUN_STATUSES = new Set<JobRunRecord["status"]>(["started", "running", "needs_input"]);
const CODEX_FULL_ACCESS_ARG = "--dangerously-bypass-approvals-and-sandbox";
const CLAUDE_FULL_ACCESS_ARG = "--dangerously-skip-permissions";

export class JobService {
  private readonly store: JobStore;
  private readonly monitors = new Map<string, Promise<JobRunRecord>>();

  constructor(
    pool: Pool,
    private readonly agentManager: AgentManager,
    private readonly logger: FastifyBaseLogger,
    private readonly config: AppConfig
  ) {
    this.store = new JobStore(pool);
  }

  async runJob(input: RunJobInput): Promise<RunJobResult> {
    const definition = await readJobDefinition(input.directory, input.name);
    const job = await this.store.upsertJobFromDefinition(definition);
    const activeRun = await this.store.findActiveRun(job.id);
    if (activeRun) {
      throw new Error(`Job "${job.name}" already has active run ${activeRun.id} (${activeRun.status}).`);
    }

    let run = await this.store.createRun(job.id, buildRunConfig(definition));
    const prompt = buildJobPrompt(definition, {
      jobId: job.id,
      runId: run.id,
      additionalInstructions: job.additionalInstructions
    });

    try {
      const agent = await this.agentManager.createAgent({
        name: `job-${job.name}-${run.id.slice(0, 8)}`,
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
    return run;
  }

  async failRunForAgent(agentId: string, report: unknown): Promise<JobRunRecord> {
    const run = await this.store.failRunForAgent(agentId, report);
    this.monitors.delete(run.id);
    return run;
  }

  async markNeedsInputForAgent(agentId: string, question: string): Promise<JobRunRecord> {
    return await this.store.markNeedsInputForAgent(agentId, question);
  }

  async logForAgent(
    agentId: string,
    input: { task: string; message: string; level: "debug" | "info" | "warn" | "error" }
  ): Promise<JobRunRecord> {
    return await this.store.logForAgent(agentId, input);
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

    while (ACTIVE_RUN_STATUSES.has(current.status)) {
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
    return await this.store.markTimedOut(run.id, {
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
  }

  private async markCrashed(run: JobRunRecord, message: string, taskName = "guardrails"): Promise<JobRunRecord> {
    const diagnostics = run.agentId ? await this.readAgentDiagnostics(run.agentId) : "";
    const fullMessage = diagnostics ? `${message}\n\n${diagnostics}` : message;
    this.logger.warn({ runId: run.id, agentId: run.agentId }, message);
    return await this.store.markCrashed(run.id, {
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

function buildRunConfig(definition: JobDefinition): JobRunConfig {
  return {
    directory: definition.directory,
    filePath: definition.filePath,
    name: definition.name,
    schedule: definition.schedule,
    timeoutMs: definition.timeoutMs,
    needsInputTimeoutMs: definition.needsInputTimeoutMs,
    notify: definition.notify
  };
}

function buildJobPrompt(definition: JobDefinition, opts: {
  jobId: string;
  runId: string;
  additionalInstructions: JobRecord["additionalInstructions"];
}): string {
  const additional = opts.additionalInstructions?.trim()
    ? `\n\nAdditional server-side instructions:\n${opts.additionalInstructions.trim()}`
    : "";
  return [
    "You are running as a Dispatch Job agent.",
    `Job ID: ${opts.jobId}`,
    `Run ID: ${opts.runId}`,
    "Use the job-specific MCP tools for lifecycle control.",
    "Call job_log for task-level progress.",
    "Call exactly one terminal tool before stopping: job_complete(report), job_failed(report), or job_needs_input(question).",
    "Terminal completed/failed states must include a structured report with status, summary, and tasks.",
    "Use repo tools when they are relevant to the job.",
    additional,
    "\nJob prompt:",
    definition.body
  ].filter(Boolean).join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
