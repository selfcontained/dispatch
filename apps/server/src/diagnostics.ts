import {
  appendFile,
  copyFile,
  mkdir,
  open,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";

import { errorMessage } from "./shared/lib/error-message.js";
import { runCommand } from "./shared/lib/run-command.js";

const TMUX_INVENTORY_INTERVAL_MS = 60_000;
const LOG_MAINTENANCE_INTERVAL_MS = 5 * 60_000;
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const DIAGNOSTICS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SERVER_LOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

const diagnosticsRoot = (): string =>
  path.join(os.homedir(), ".dispatch", "diagnostics");

const serverLogPath = (): string =>
  path.join(os.homedir(), ".dispatch", "logs", "dispatch.log");

/**
 * Wrapper that swallows runCommand failures into a structured result so
 * the caller (a diagnostic capture) can record partial state instead of
 * aborting on one failed subprocess.
 */
async function captureCommand(
  command: string,
  args: string[],
  allowedExitCodes: number[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    return await runCommand(command, args, { allowedExitCodes });
  } catch (error) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: errorMessage(error),
    };
  }
}

/**
 * Rotate by renaming: `<file>` -> `<file>.1`, `<file>.1` -> `<file>.2`, etc.
 * No-op if the file is below `MAX_LOG_SIZE_BYTES` or doesn't exist.
 *
 * Exported for unit testing — the backup-number shifting has off-by-one
 * potential and is the kind of thing that's worth locking in.
 */
export async function rotateFile(
  filePath: string,
  maxBackups: number
): Promise<void> {
  try {
    const s = await stat(filePath);
    if (s.size < MAX_LOG_SIZE_BYTES) return;
  } catch {
    return; // file doesn't exist
  }

  // Shift existing backups
  for (let i = maxBackups; i >= 1; i--) {
    const src = i === 1 ? filePath : `${filePath}.${i - 1}`;
    const dst = `${filePath}.${i}`;
    try {
      await rename(src, dst);
    } catch {
      /* missing, skip */
    }
  }
}

/**
 * Copy the file to a `.1` backup, then truncate it in place. Preserves
 * any open file descriptors (e.g. launchd's stdout/stderr handle on the
 * server log), which is why we copy-truncate rather than rename-rotate.
 *
 * Has the same small data-loss window between copy and truncate as
 * `logrotate copytruncate` — acceptable for diagnostic logs.
 *
 * Exported for unit testing.
 */
export async function copyTruncateFile(
  filePath: string,
  maxBackups: number
): Promise<void> {
  try {
    const s = await stat(filePath);
    if (s.size < MAX_LOG_SIZE_BYTES) return;
  } catch {
    return;
  }

  // Shift existing backups
  for (let i = maxBackups; i >= 2; i--) {
    try {
      await rename(`${filePath}.${i - 1}`, `${filePath}.${i}`);
    } catch {
      /* missing */
    }
  }

  await copyFile(filePath, `${filePath}.1`);
  const fh = await open(filePath, "r+");
  try {
    await fh.truncate(0);
  } finally {
    await fh.close();
  }
}

/**
 * Delete files in `dir` whose names match `pattern` and whose mtime is
 * older than `maxAgeMs`. Silently ignores missing dirs and files that
 * vanish mid-iteration.
 *
 * Exported for unit testing.
 */
export async function deleteOldFiles(
  dir: string,
  pattern: RegExp,
  maxAgeMs: number
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  const now = Date.now();
  for (const entry of entries) {
    if (!pattern.test(entry)) continue;
    const filePath = path.join(dir, entry);
    try {
      const s = await stat(filePath);
      if (now - s.mtimeMs > maxAgeMs) {
        await unlink(filePath);
      }
    } catch {
      /* already gone or inaccessible */
    }
  }
}

export type DiagnosticsRecorder = {
  /**
   * Rotate the dispatch server log when it exceeds 10 MB, and prune
   * diagnostic JSON / rotated log files older than the configured retention
   * windows. Throttled to once every five minutes.
   */
  maybeMaintenanceLogs(): Promise<void>;
};

/**
 * Build a diagnostics recorder bound to the given logger. The recorder
 * owns just two things: the throttle clocks for the two `maybe*`
 * methods, and the bound logger used to swallow-and-warn on capture
 * failures. All file/process work is delegated to module-scope helpers.
 */
export function createDiagnosticsRecorder(
  logger: FastifyBaseLogger
): DiagnosticsRecorder {
  let lastLogMaintenanceAt = 0;

  return {
    async maybeMaintenanceLogs(): Promise<void> {
      const now = Date.now();
      if (now - lastLogMaintenanceAt < LOG_MAINTENANCE_INTERVAL_MS) {
        return;
      }
      lastLogMaintenanceAt = now;

      try {
        // Rotate dispatch.log via copytruncate (keep 3 backups)
        await copyTruncateFile(serverLogPath(), 3);

        // Delete old diagnostics JSON files (> 7 days)
        await deleteOldFiles(
          diagnosticsRoot(),
          /\.json$/,
          DIAGNOSTICS_MAX_AGE_MS
        );

        // Delete old rotated server logs (> 14 days)
        await deleteOldFiles(
          path.join(os.homedir(), ".dispatch", "logs"),
          /dispatch\.log\.\d+$/,
          SERVER_LOG_MAX_AGE_MS
        );
      } catch (error) {
        logger.warn({ err: error }, "Log maintenance failed.");
      }
    },
  };
}
