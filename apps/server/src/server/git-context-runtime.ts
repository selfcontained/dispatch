import path from "node:path";

import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import type {
  AgentGitContext,
  AgentManager,
  AgentRecord,
} from "../agents/manager.js";
import { runCommand } from "../shared/lib/run-command.js";

type GitRefreshResult =
  | "updated"
  | "unchanged"
  | "probe_error"
  | "failed"
  | "skipped";

type GitRefreshAgentDiagnostics = {
  lastQueuedAt: number | null;
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  lastDurationMs: number | null;
  lastResult: GitRefreshResult | null;
  lastError: string | null;
};

type CreateGitContextRuntimeDeps = {
  pool: Pool;
  agentManager: AgentManager;
  appLog: FastifyBaseLogger;
  publishUiEvent: (event: unknown) => void;
  withStreamFlag: <T extends AgentRecord>(
    agent: T
  ) => T & { hasStream: boolean };
  probeCommandTimeoutMs: number;
  refreshIntervalMs: number;
  refreshConcurrency: number;
  minRequeueMs: number;
  diagnosticsHistoryLimit: number;
};

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  const trimmed = resolved.replace(/[\\/]+$/, "");
  return trimmed.length > 0 ? trimmed : resolved;
}

function areGitContextsEqual(
  left: AgentGitContext | null,
  right: AgentGitContext | null
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.repoRoot === right.repoRoot &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    left.worktreeName === right.worktreeName &&
    left.isWorktree === right.isWorktree
  );
}

export function percentile(
  sortedValues: number[],
  quantile: number
): number | null {
  if (sortedValues.length === 0) {
    return null;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.floor((sortedValues.length - 1) * quantile))
  );
  return sortedValues[index] ?? null;
}

export function toIso(epochMs: number | null): string | null {
  if (epochMs === null) {
    return null;
  }
  return new Date(epochMs).toISOString();
}

export function createGitContextRuntime(deps: CreateGitContextRuntimeDeps) {
  const {
    pool,
    agentManager,
    appLog,
    publishUiEvent,
    withStreamFlag,
    probeCommandTimeoutMs,
    refreshIntervalMs,
    refreshConcurrency,
    minRequeueMs,
    diagnosticsHistoryLimit,
  } = deps;

  const pendingAgentIds = new Set<string>();
  const activeAgentIds = new Set<string>();
  const pendingEnqueuedAt = new Map<string, number>();
  const durationsMs: number[] = [];
  const agentDiagnostics = new Map<string, GitRefreshAgentDiagnostics>();
  const counters = {
    enqueued: 0,
    started: 0,
    completed: 0,
    updated: 0,
    unchanged: 0,
    probeErrors: 0,
    failed: 0,
    timedOut: 0,
    skipped: 0,
  };

  let refreshTimer: NodeJS.Timeout | null = null;

  function ensureAgentDiagnostics(agentId: string): GitRefreshAgentDiagnostics {
    const existing = agentDiagnostics.get(agentId);
    if (existing) {
      return existing;
    }
    const created: GitRefreshAgentDiagnostics = {
      lastQueuedAt: null,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastDurationMs: null,
      lastResult: null,
      lastError: null,
    };
    agentDiagnostics.set(agentId, created);
    return created;
  }

  function recordCompletion(
    agentId: string,
    startedAt: number,
    result: GitRefreshResult,
    errorMessage: string | null
  ): void {
    const completedAt = Date.now();
    const duration = Math.max(0, completedAt - startedAt);
    counters.completed += 1;
    if (result === "updated") counters.updated += 1;
    else if (result === "unchanged") counters.unchanged += 1;
    else if (result === "probe_error") counters.probeErrors += 1;
    else if (result === "failed") counters.failed += 1;
    else if (result === "skipped") counters.skipped += 1;

    if (result === "failed" && errorMessage?.includes("Command timed out")) {
      counters.timedOut += 1;
    }

    durationsMs.push(duration);
    if (durationsMs.length > diagnosticsHistoryLimit) {
      durationsMs.shift();
    }

    const diag = ensureAgentDiagnostics(agentId);
    diag.lastCompletedAt = completedAt;
    diag.lastDurationMs = duration;
    diag.lastResult = result;
    diag.lastError = errorMessage;
  }

  async function resolveRepoRoot(cwd: string): Promise<string> {
    const commonDirResult = await runCommand(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { allowedExitCodes: [0, 128], timeoutMs: probeCommandTimeoutMs }
    );

    if (commonDirResult.exitCode === 0 && commonDirResult.stdout) {
      const commonDir = normalizePath(commonDirResult.stdout);
      if (path.basename(commonDir) === ".git") {
        return normalizePath(path.dirname(commonDir));
      }
    }

    const fallbackCommonDirResult = await runCommand(
      "git",
      ["-C", cwd, "rev-parse", "--git-common-dir"],
      { allowedExitCodes: [0, 128], timeoutMs: probeCommandTimeoutMs }
    );
    if (
      fallbackCommonDirResult.exitCode === 0 &&
      fallbackCommonDirResult.stdout
    ) {
      const commonDir = fallbackCommonDirResult.stdout;
      const absoluteCommonDir = normalizePath(
        path.isAbsolute(commonDir) ? commonDir : path.resolve(cwd, commonDir)
      );
      if (path.basename(absoluteCommonDir) === ".git") {
        return normalizePath(path.dirname(absoluteCommonDir));
      }
    }

    return normalizePath(
      (
        await runCommand("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
          allowedExitCodes: [0],
          timeoutMs: probeCommandTimeoutMs,
        })
      ).stdout
    );
  }

  async function resolveWorktreeRoot(cwd: string): Promise<string> {
    return normalizePath(
      (
        await runCommand("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
          allowedExitCodes: [0],
          timeoutMs: probeCommandTimeoutMs,
        })
      ).stdout
    );
  }

  async function probeGitContext(
    cwd: string
  ): Promise<
    { status: "ok"; value: AgentGitContext | null } | { status: "error" }
  > {
    try {
      const inside = await runCommand(
        "git",
        ["-C", cwd, "rev-parse", "--is-inside-work-tree"],
        { allowedExitCodes: [0, 128], timeoutMs: probeCommandTimeoutMs }
      );
      if (inside.exitCode !== 0 || inside.stdout !== "true") {
        return { status: "ok", value: null };
      }

      const repoRoot = await resolveRepoRoot(cwd);
      const checkoutRoot = normalizePath(
        (
          await runCommand("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
            allowedExitCodes: [0],
            timeoutMs: probeCommandTimeoutMs,
          })
        ).stdout
      );

      let branch = (
        await runCommand(
          "git",
          ["-C", cwd, "symbolic-ref", "--short", "-q", "HEAD"],
          {
            allowedExitCodes: [0, 1],
            timeoutMs: probeCommandTimeoutMs,
          }
        )
      ).stdout;
      if (!branch) {
        branch = (
          await runCommand("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], {
            allowedExitCodes: [0],
            timeoutMs: probeCommandTimeoutMs,
          })
        ).stdout;
      }

      return {
        status: "ok",
        value: {
          repoRoot,
          branch,
          worktreePath: checkoutRoot,
          worktreeName: path.basename(checkoutRoot),
          isWorktree: checkoutRoot !== repoRoot,
        },
      };
    } catch {
      return { status: "error" };
    }
  }

  async function persistGitContext(
    agentId: string,
    gitContext: AgentGitContext | null,
    stale: boolean
  ): Promise<void> {
    await pool.query(
      `
      UPDATE agents
      SET git_context = $2::jsonb,
          git_context_stale = $3,
          git_context_updated_at = NOW()
      WHERE id = $1
      `,
      [agentId, gitContext ? JSON.stringify(gitContext) : null, stale]
    );
  }

  async function refreshAgentContext(
    agentId: string
  ): Promise<GitRefreshResult> {
    const agent = await agentManager.getAgent(agentId);
    if (!agent) {
      return "skipped";
    }

    const cwd = await agentManager.resolveRuntimeCwd(agent);
    const probe = await probeGitContext(cwd);
    if (probe.status === "error") {
      await persistGitContext(agentId, agent.gitContext, true);
      return "probe_error";
    }

    const nextContext = probe.value;
    const shouldPublish =
      agent.gitContextStale ||
      !areGitContextsEqual(agent.gitContext, nextContext);

    await persistGitContext(agentId, nextContext, false);
    if (!shouldPublish) {
      return "unchanged";
    }

    const refreshed = await agentManager.getAgent(agentId);
    if (refreshed) {
      publishUiEvent({
        type: "agent.upsert",
        agent: withStreamFlag(refreshed),
      });
    }
    return "updated";
  }

  async function drainQueue(): Promise<void> {
    while (
      activeAgentIds.size < refreshConcurrency &&
      pendingAgentIds.size > 0
    ) {
      const nextAgentId = pendingAgentIds.values().next().value as
        | string
        | undefined;
      if (!nextAgentId) {
        return;
      }

      pendingAgentIds.delete(nextAgentId);
      pendingEnqueuedAt.delete(nextAgentId);
      if (activeAgentIds.has(nextAgentId)) {
        continue;
      }

      activeAgentIds.add(nextAgentId);
      counters.started += 1;
      const startedAt = Date.now();
      const diag = ensureAgentDiagnostics(nextAgentId);
      diag.lastStartedAt = startedAt;
      diag.lastError = null;

      void refreshAgentContext(nextAgentId)
        .then((result) => {
          recordCompletion(nextAgentId, startedAt, result, null);
        })
        .catch((error) => {
          const message =
            error instanceof Error ? error.message : String(error);
          recordCompletion(nextAgentId, startedAt, "failed", message);
          appLog.warn(
            { err: error, agentId: nextAgentId },
            "Git context refresh failed."
          );
        })
        .finally(() => {
          activeAgentIds.delete(nextAgentId);
          void drainQueue().catch((err) => {
            appLog.warn({ err }, "Git context refresh queue drain failed");
          });
        });
    }
  }

  async function refreshAllContexts(): Promise<void> {
    try {
      const agents = await agentManager.listAgents();
      queue(agents.map((agent) => agent.id));
    } catch (error) {
      appLog.warn({ err: error }, "Failed to queue git context refresh.");
    }
  }

  function queue(agentIds: string[]): void {
    const now = Date.now();
    for (const agentId of agentIds) {
      if (!agentId) {
        continue;
      }
      const existing = agentDiagnostics.get(agentId);
      const lastQueuedAt = existing?.lastQueuedAt ?? null;
      const wasPending = pendingAgentIds.has(agentId);
      const wasActive = activeAgentIds.has(agentId);
      const queuedRecently =
        lastQueuedAt !== null && now - lastQueuedAt < minRequeueMs;
      if (wasPending || wasActive || queuedRecently) {
        continue;
      }
      if (!wasPending && !wasActive) {
        pendingEnqueuedAt.set(agentId, now);
      }
      ensureAgentDiagnostics(agentId).lastQueuedAt = now;
      pendingAgentIds.add(agentId);
      counters.enqueued += 1;
    }
    void drainQueue().catch((err) => {
      appLog.warn({ err }, "Git context refresh queue drain failed");
    });
  }

  function startLoop(): void {
    if (refreshTimer) {
      return;
    }
    refreshTimer = setInterval(() => {
      void refreshAllContexts().catch((err) => {
        appLog.warn({ err }, "Git context refresh cycle failed");
      });
    }, refreshIntervalMs);
  }

  function stopLoop(): void {
    if (!refreshTimer) {
      return;
    }
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  function clearAgent(agentId: string): void {
    pendingAgentIds.delete(agentId);
    pendingEnqueuedAt.delete(agentId);
    activeAgentIds.delete(agentId);
    agentDiagnostics.delete(agentId);
  }

  return {
    pendingAgentIds,
    activeAgentIds,
    pendingEnqueuedAt,
    durationsMs,
    agentDiagnostics,
    counters,
    queue,
    startLoop,
    stopLoop,
    clearAgent,
    resolveRepoRoot,
    resolveWorktreeRoot,
  };
}
