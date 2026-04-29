import type { FastifyBaseLogger } from "fastify";

import { runCommand } from "../shared/lib/run-command.js";
import { loadRepoHooks } from "../shared/mcp/repo-tools.js";

import type { AgentRecord } from "./types.js";

/**
 * Names of repo-defined lifecycle hooks invoked at specific points in
 * the agent's life. Today only `stop` is wired through; if more hooks
 * are added (e.g. `archive`, `restart`), they belong here too.
 */
export type LifecycleHookName = "stop";

/**
 * Run a repo-defined lifecycle hook for `agent`. Best-effort:
 *   - No-op when the agent has no `worktreePath` / `cwd` to anchor on.
 *   - No-op when the repo's `.dispatch/tools.json` doesn't define this
 *     hook.
 *   - Non-zero exit codes are logged at `warn` level but never thrown
 *     — caller (stopAgent / executeArchive) can't usefully respond
 *     to a hook failure beyond logging.
 *
 * Runs with `DISPATCH_AGENT_ID` exported in env so the hook can
 * disambiguate which agent triggered it. 15-second hard timeout.
 *
 * Lives outside the manager because the operation isn't manager-state-
 * coupled — it just shells out to a repo-defined command, given an
 * agent record. Keeping it standalone makes it the natural home for
 * additional hook names without growing the manager class.
 */
export async function runLifecycleHook(
  hookName: LifecycleHookName,
  agent: AgentRecord,
  logger: FastifyBaseLogger
): Promise<void> {
  const repoRoot = agent.worktreePath ?? agent.cwd;
  if (!repoRoot) return;

  const hooks = await loadRepoHooks(repoRoot);
  const hook = hooks[hookName];
  if (!hook) return;

  const [command, ...args] = hook.command;
  logger.info(
    { agentId: agent.id, hook: hookName, command: hook.command },
    "Running lifecycle hook"
  );

  const result = await runCommand(command, args, {
    cwd: repoRoot,
    env: {
      DISPATCH_AGENT_ID: agent.id,
    },
    timeoutMs: 15_000,
  });

  if (result.exitCode !== 0) {
    logger.warn(
      {
        agentId: agent.id,
        hook: hookName,
        exitCode: result.exitCode,
        stderr: result.stderr,
      },
      "Lifecycle hook exited with non-zero code"
    );
  }
}
