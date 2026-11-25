import type { FastifyBaseLogger } from "fastify";

import { repoCommandEnvironment } from "../shared/lib/tool-environment.js";
import { runCommand } from "../shared/lib/run-command.js";
import { loadRepoHooks } from "../shared/mcp/repo-tools.js";

import type { AgentRecord } from "./types.js";

export type LifecycleHookName = "stop" | "archive";

/**
 * Run an optional repo hook in the launch checkout and any moved workspace.
 * Callers treat stop as best-effort and require archive cleanup to succeed
 * before removing the worktree and soft-deleting the agent.
 */
export async function runLifecycleHook(
  hookName: LifecycleHookName,
  agent: AgentRecord,
  logger: FastifyBaseLogger
): Promise<void> {
  // An agent that moved runs the hook in both places: what it started in
  // the launch checkout and what it started in its workspace (a dev stack,
  // say) each belong to that checkout's own hook.
  const roots = new Set(
    [agent.worktreePath ?? agent.cwd, agent.workspacePath].filter(
      (root): root is string => Boolean(root)
    )
  );
  for (const root of roots) {
    const ran = await runLifecycleHookIn(hookName, agent, root, logger);
    if (
      !ran &&
      hookName === "archive" &&
      root === agent.worktreePath &&
      agent.launchCwd &&
      !roots.has(agent.launchCwd)
    ) {
      // A retained worktree can predate the archive hook. Run the configured
      // hook from the original launch checkout in that case.
      await runLifecycleHookIn(hookName, agent, agent.launchCwd, logger);
    }
  }
}

async function runLifecycleHookIn(
  hookName: LifecycleHookName,
  agent: AgentRecord,
  repoRoot: string,
  logger: FastifyBaseLogger
): Promise<boolean> {
  const hooks = await loadRepoHooks(repoRoot);
  const hook = hooks[hookName];
  if (!hook) return false;

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
  return true;
}
