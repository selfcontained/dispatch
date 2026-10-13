import { stat } from "node:fs/promises";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";

import { withToolSearchPath } from "../shared/lib/tool-environment.js";
import { runCommand } from "../shared/lib/run-command.js";
import { copyLocalConfigFiles } from "./worktree-local-config.js";

/**
 * Lockfile → package-manager command for the auto-deps-install path.
 * The first match wins, so the priority order matters: a project that
 * has both `pnpm-lock.yaml` and `yarn.lock` checked in is treated as a
 * pnpm project.
 */
const LOCKFILE_INSTALL_COMMANDS: ReadonlyArray<
  readonly [string, string, readonly string[]]
> = [
  ["pnpm-lock.yaml", "pnpm", ["install"]],
  ["yarn.lock", "yarn", ["install"]],
  ["package-lock.json", "npm", ["install"]],
  ["bun.lock", "bun", ["install"]],
  ["bun.lockb", "bun", ["install"]],
];

export type WorkspaceProgress = {
  phase: "env" | "deps";
  status?: "done" | "failed";
  detail?: string;
};

/**
 * Prepare a freshly-created worktree for use as an agent workspace:
 *
 *   1. Copy the source repo's gitignored local config/secret files
 *      into the worktree (best-effort — a missing source file is a
 *      no-op, not an error). See `worktree-local-config.ts` for the
 *      pattern list and copy rules.
 *   2. Detect a lockfile and run the matching package manager's install.
 *      First match in `LOCKFILE_INSTALL_COMMANDS` wins; install failures
 *      are logged but not propagated (the worktree is usable without
 *      deps for the agent's first turn, and the user can re-run install
 *      themselves if needed).
 *
 * Called from `agents/workspace.ts` on every launch; it sits under
 * `agents/` rather than `shared/git/` because it is an agent-launch step,
 * not a git operation.
 */
export async function setupAgentWorkspace(
  originalCwd: string,
  worktreePath: string,
  logger: FastifyBaseLogger,
  onProgress?: (progress: WorkspaceProgress) => Promise<void>
): Promise<void> {
  await onProgress?.({ phase: "env" });
  const copied = await copyLocalConfigFiles(originalCwd, worktreePath);
  if (copied.length > 0) {
    logger.info(
      { worktreePath, files: copied },
      `Copied ${copied.length} local config file(s) into worktree.`
    );
  }

  await onProgress?.({ phase: "deps" });
  for (const [lockfile, bin, args] of LOCKFILE_INSTALL_COMMANDS) {
    const lockPath = path.join(worktreePath, lockfile);
    const exists = await stat(lockPath).catch(() => null);
    if (!exists) continue;

    logger.info(
      { worktreePath, packageManager: bin },
      "Installing dependencies in worktree."
    );
    try {
      await runCommand(bin, [...args], {
        cwd: worktreePath,
        env: withToolSearchPath(),
        timeoutMs: 120_000,
      });
      logger.info(
        { worktreePath, packageManager: bin },
        "Dependency install complete."
      );
      await onProgress?.({
        phase: "deps",
        status: "done",
        detail: `${bin} install completed`,
      });
    } catch (error) {
      await onProgress?.({
        phase: "deps",
        status: "failed",
        detail: `${bin} install failed; continuing launch; dependencies may be incomplete. ${error instanceof Error ? error.message : String(error)}`,
      });
      logger.warn(
        { err: error, worktreePath, packageManager: bin },
        "Dependency install failed."
      );
    }
    return;
  }
  await onProgress?.({
    phase: "deps",
    status: "done",
    detail:
      "No supported lockfile found; automatic dependency installation skipped.",
  });
}
