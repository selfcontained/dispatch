import type { FastifyBaseLogger } from "fastify";

import {
  requestCheckoutCommand,
  type CheckoutCommandRunners,
} from "./checkout-commands.js";
import {
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
 * A runner's update fence can land between any two of its requests:
 * `whileFenced` repeats the refused one once the runner's hold opens.
 */
export async function runLifecycleHook(
  hookName: LifecycleHookName,
  agent: AgentRecord,
  logger: FastifyBaseLogger,
  runners: CheckoutCommandRunners,
  whileFenced: <T>(request: () => Promise<T>) => Promise<T> = (request) =>
    request()
): Promise<void> {
  for (const checkout of ["launch", "moved"] as const) {
    try {
      const target = { checkout, path: REPO_TOOL_MANIFEST_PATH };
      const file = await whileFenced(() =>
        requestCheckoutCommand(runners, agent, { ...target, kind: "read" })
      );
      const hook =
        file && parseRepoHooks(parseRepoToolFile(file.content))[hookName];
      if (!hook) continue;
      logger.info(
        { agentId: agent.id, hook: hookName, checkout },
        "Running lifecycle hook"
      );
      const result = await whileFenced(() =>
        requestCheckoutCommand(runners, agent, {
          ...target,
          kind: "run",
          state: file.state,
          argv: hook.command,
        })
      );
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
}
