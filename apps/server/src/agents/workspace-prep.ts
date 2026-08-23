import { stat } from "node:fs/promises";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";

import { runCommand } from "../shared/lib/run-command.js";
import { copyLocalConfigFiles } from "./worktree-local-config.js";

/**
 * Lockfile → package-manager command for the auto-deps-install path.
 * The first match wins, so the priority order matters: a project that
 * has both `pnpm-lock.yaml` and `yarn.lock` checked in is treated as a
 * pnpm project (matches `agents/tmux/setup-script.ts`'s tmux-mode
 * equivalent so both launch paths agree).
 */
const LOCKFILE_INSTALL_COMMANDS: ReadonlyArray<
  readonly [string, string, readonly string[]]
> = [
  ["pnpm-lock.yaml", "pnpm", ["install"]],
  ["yarn.lock", "yarn", ["install"]],
  ["package-lock.json", "npm", ["install"]],
  ["bun.lockb", "bun", ["install"]],
];

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
 * Used only by the inert-mode launch path. The tmux-mode launch path
 * does the equivalent inside the bash setup script that runs in the
 * agent's pane (see `agents/tmux/setup-script.ts`), which is why this
 * module sits under `agents/` rather than `shared/git/` — it's not a
 * git operation, it's an agent-launch step.
 */
export async function setupAgentWorkspace(
  originalCwd: string,
  worktreePath: string,
  logger: FastifyBaseLogger
): Promise<void> {
  const { copied, skipped } = await copyLocalConfigFiles(
    originalCwd,
    worktreePath
  );
  if (copied.length > 0) {
    logger.info(
      { worktreePath, files: copied },
      `Copied ${copied.length} local config file(s) into worktree.`
    );
  }
  for (const { name, reason } of skipped) {
    logger.warn(
      { worktreePath, file: name, reason },
      reason === "symlink"
        ? "Skipped a symlinked local config file — copy the target instead."
        : "Skipped a local config file that git does not ignore."
    );
  }

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
        timeoutMs: 120_000,
      });
      logger.info(
        { worktreePath, packageManager: bin },
        "Dependency install complete."
      );
    } catch (error) {
      logger.warn(
        { err: error, worktreePath, packageManager: bin },
        "Dependency install failed."
      );
    }
    return;
  }
}
