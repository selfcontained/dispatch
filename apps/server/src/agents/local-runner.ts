import { realpath } from "node:fs/promises";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";

import {
  createWorkspacePreparation,
  resolveLaunchDirectory,
} from "./workspace.js";
import { resolveProjectRoot } from "../projects/resolve-root.js";
import { localCheckoutRelease } from "./local-runner-checkout.js";
import { inferRepositoryUrl } from "./remote/repository.js";

/** Workspace and file helpers for workloads sharing the controller account. */
export function createLocalRunner(
  agentStateRoot: string,
  _logger?: FastifyBaseLogger
) {
  function stateDir(agentId: string) {
    if (
      !agentId ||
      agentId === "." ||
      agentId === ".." ||
      path.basename(agentId) !== agentId
    )
      throw new Error("Invalid agent state directory");
    return path.join(agentStateRoot, agentId);
  }
  const workspace = createWorkspacePreparation();
  return {
    checkoutRelease: localCheckoutRelease,
    resolveLaunchDirectory,
    canonicalPath: (directory: string) => realpath(directory).catch(() => null),
    resolveProjectRoot,
    inferRepositoryUrl,
    /**
     * Record a launch's worktree request before its row exists, in the
     * receipt the local runner prepares from. Without a request, bring a
     * receipt an earlier build of this branch wrote into the runner's shape
     * before the runner resumes it.
     */
    bindWorkspace: (
      agentId: string,
      ...intent:
        | [
            directory: Parameters<typeof workspace.bind>[1],
            request: Parameters<typeof workspace.bind>[2],
          ]
        | []
    ) =>
      intent.length
        ? workspace.bind(stateDir(agentId), ...intent)
        : workspace.upgrade(stateDir(agentId)),
    requestedWorktree: (agentId: string) =>
      workspace.requested(stateDir(agentId)),
  };
}
