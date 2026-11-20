import { remotePlacement } from "./remote/protocol.js";
import type { FastifyBaseLogger } from "fastify";

import { repoCommandEnvironment } from "../shared/lib/tool-environment.js";
import { runCommand } from "../shared/lib/run-command.js";
import { requestCheckoutCommand } from "./checkout-commands.js";
import type { RemoteRunnerService } from "./remote/service.js";
import {
  loadRepoHooks,
  parseRepoHooks,
  parseRepoToolFile,
  REPO_TOOL_MANIFEST_PATH,
} from "../shared/mcp/repo-tools.js";

import type { AgentRecord } from "./types.js";

/**
 * Names of repo-defined lifecycle hooks invoked at specific points in
 * the agent's life. Today only `stop` is wired through; if more hooks
 * are added (e.g. `archive`, `restart`), they belong here too.
 */
export type LifecycleHookName = "stop";

/**
 * Run a repo-defined lifecycle hook for `agent`. Best-effort:
 *   - Runs once per checkout: the launch worktree/cwd, and the moved
 *     workspace when there is one.
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
  logger: FastifyBaseLogger,
  remote?: RemoteRunnerService
): Promise<void> {
  if (remotePlacement(agent.cwd)) {
    for (const checkout of ["launch", "moved"] as const) {
      try {
        const target = { checkout, path: REPO_TOOL_MANIFEST_PATH };
        const file = await requestCheckoutCommand(remote, agent, {
          ...target,
          kind: "read",
        });
        const hook =
          file && parseRepoHooks(parseRepoToolFile(file.content))[hookName];
        if (!hook) continue;
        const result = await requestCheckoutCommand(remote, agent, {
          ...target,
          kind: "run",
          state: file.state,
          argv: hook.command,
        });
        if (result.exitCode !== 0) {
          logger.warn(
            {
              agentId: agent.id,
              hook: hookName,
              checkout,
              exitCode: result.exitCode,
              stderr: result.stderr,
              truncated: result.truncated,
            },
            "Lifecycle hook exited with non-zero code"
          );
        }
      } catch (err) {
        logger.warn(
          { err, agentId: agent.id, hook: hookName, checkout },
          "Runner lifecycle hook failed; continuing shutdown"
        );
      }
    }
    return;
  }
  // An agent that moved runs the hook in both places: what it started in
  // the launch checkout and what it started in its workspace (a dev stack,
  // say) each belong to that checkout's own hook.
  const roots = new Set(
    [agent.worktreePath ?? agent.cwd, agent.workspacePath].filter(
      (root): root is string => Boolean(root)
    )
  );
  for (const root of roots) {
    await runLifecycleHookIn(hookName, agent, root, logger);
  }
}

async function runLifecycleHookIn(
  hookName: LifecycleHookName,
  agent: AgentRecord,
  repoRoot: string,
  logger: FastifyBaseLogger
): Promise<void> {
  const hooks = await loadRepoHooks(repoRoot);
  const hook = hooks[hookName];
  if (!hook) return;

  const [command, ...args] = hook.command;
  logger.info(
    { agentId: agent.id, hook: hookName, command: hook.command, repoRoot },
    "Running lifecycle hook"
  );

  const result = await runCommand(command, args, {
    cwd: repoRoot,
    env: repoCommandEnvironment(agent.id),
    timeoutMs: 15_000,
  });

  if (result.exitCode !== 0) {
    logger.warn(
      {
        agentId: agent.id,
        hook: hookName,
        repoRoot,
        exitCode: result.exitCode,
        stderr: result.stderr,
      },
      "Lifecycle hook exited with non-zero code"
    );
  }
}
