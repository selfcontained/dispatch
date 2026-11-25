import type { FastifyBaseLogger } from "fastify";

import { repoCommandEnvironment } from "../shared/lib/tool-environment.js";
import { runCommand } from "../shared/lib/run-command.js";
import {
  loadRepoHooks,
  type RepoHookDefinition,
} from "../shared/mcp/repo-tools.js";

import type { AgentRecord } from "./types.js";

export type LifecycleHookName = "stop" | "archive";

type ResolvedHook = {
  root: string;
  hook: RepoHookDefinition;
};

/** Resolve the same checkout and fallback for a preview and for execution. */
export async function* resolveLifecycleHooks(
  hookName: LifecycleHookName,
  agent: AgentRecord
): AsyncGenerator<ResolvedHook> {
  const roots = new Set(
    [agent.worktreePath ?? agent.cwd, agent.workspacePath].filter(
      (root): root is string => Boolean(root)
    )
  );
  for (const root of roots) {
    const hook = (await loadRepoHooks(root))[hookName];
    if (hook) {
      yield { root, hook };
    } else if (
      hookName === "archive" &&
      root === agent.worktreePath &&
      agent.launchCwd &&
      !roots.has(agent.launchCwd)
    ) {
      // A retained worktree can predate the archive hook.
      const fallback = (await loadRepoHooks(agent.launchCwd)).archive;
      if (fallback) yield { root: agent.launchCwd, hook: fallback };
    }
  }
}

/**
 * Callers treat stop as best-effort and require archive cleanup to succeed
 * before removing the worktree and soft-deleting the agent.
 */
export async function runLifecycleHook(
  hookName: LifecycleHookName,
  agent: AgentRecord,
  logger: FastifyBaseLogger
): Promise<void> {
  for await (const { root, hook } of resolveLifecycleHooks(hookName, agent)) {
    await runLifecycleHookIn(hookName, agent, root, hook, logger);
  }
}

async function runLifecycleHookIn(
  hookName: LifecycleHookName,
  agent: AgentRecord,
  repoRoot: string,
  hook: RepoHookDefinition,
  logger: FastifyBaseLogger
): Promise<void> {
  const [command, ...args] = hook.command;
  logger.info(
    { agentId: agent.id, hook: hookName, command: hook.command, repoRoot },
    "Running lifecycle hook"
  );

  const result = await runCommand(command, args, {
    cwd: repoRoot,
    env: repoCommandEnvironment(agent.id),
    timeoutMs: hookName === "archive" ? 60_000 : 15_000,
  });

  if (hookName === "archive" && result.stdout) {
    logger.info(
      { agentId: agent.id, repoRoot, output: result.stdout },
      "Archive hook completed"
    );
  }
}
