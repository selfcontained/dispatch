import { realpath } from "node:fs/promises";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";

import { createWorkspacePreparation } from "./workspace.js";
import { resolveProjectRoot } from "../projects/resolve-root.js";
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
    canonicalPath: (directory: string) => realpath(directory).catch(() => null),
    resolveProjectRoot,
    inferRepositoryUrl,
    /**
     * A receipt an earlier build wrote for the agent's worktree launch,
     * before its request was recorded on the row: brought into the runner's
     * shape (an earlier build of this branch wrote the app's), and whether
     * one is there for the runner to finish.
     */
    async bindWorkspace(agentId: string) {
      const dir = stateDir(agentId);
      await workspace.upgrade(dir);
      return workspace.requested(dir);
    },
  };
}
