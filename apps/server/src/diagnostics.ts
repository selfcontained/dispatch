import {
  appendFile,
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
import { statePath } from "./state-dir.js";
import { isMacAppManaged } from "./update-owner.js";

const TMUX_INVENTORY_INTERVAL_MS = 60_000;
const LOG_MAINTENANCE_INTERVAL_MS = 5 * 60_000;
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10 MiB
const DIAGNOSTICS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SERVER_LOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

const diagnosticsRoot = (): string => statePath("diagnostics");

// Match ServerLauncher.swift, not the legacy installer launchd path.
export const serverLogPath = (): string =>
  isMacAppManaged()
    ? statePath("server.log")
    : statePath("logs", "dispatch.log");

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

/** Read a fixed snapshot tail; never copy an unbounded historical log. */
async function readLogTail(
  file: Awaited<ReturnType<typeof open>>,
  size: number
) {
  const length = Math.min(size, MAX_LOG_SIZE_BYTES);
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await file.read(
      buffer,
      read,
      length - read,
      size - length + read
    );
    if (bytesRead === 0) break;
    read += bytesRead;
  }
  return buffer.subarray(0, read);
}

/**
 * Retain at most maxBackups bounded tails, then truncate the active inode.
 * Writers MUST use O_APPEND: preserving an inode alone does not reset a
 * non-append writer's offset. Both native Mac and installer launchd use append.
 * Writes between the snapshot and truncate can be lost (copytruncate's window).
 */
export async function copyTruncateFile(
  filePath: string,
  maxBackups: number
): Promise<void> {
  // Repair historical backups too, even when the active file is small.
  let entries: string[];
  try {
    entries = await readdir(path.dirname(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const prefix = `${path.basename(filePath)}.`;
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const suffix = entry.slice(prefix.length);
    if (!/^[1-9]\d*$/.test(suffix)) continue;
    const backupPath = path.join(path.dirname(filePath), entry);
    if (Number(suffix) > maxBackups) {
      await unlink(backupPath);
      continue;
    }
    const backup = await open(backupPath, "r+");
    try {
      const metadata = await backup.stat();
      const { size } = metadata;
      if (size > MAX_LOG_SIZE_BYTES) {
        const tail = await readLogTail(backup, size);
        await backup.writeFile(tail);
        await backup.truncate(tail.length);
        await backup.utimes(metadata.atime, metadata.mtime);
      }
    } finally {
      await backup.close();
    }
  }

  let file;
  try {
    file = await open(filePath, "r+");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const { size } = await file.stat();
    if (size < MAX_LOG_SIZE_BYTES) return;
    for (let i = maxBackups; i >= 2; i--) {
      try {
        await rename(`${filePath}.${i - 1}`, `${filePath}.${i}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (maxBackups > 0) {
      await writeFile(`${filePath}.1`, await readLogTail(file, size), {
        mode: 0o600,
      });
    }
    await file.truncate(0);
  } finally {
    await file.close();
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
   * Rotate the selected server log when it reaches 10 MiB, and prune
   * diagnostic JSON / rotated log files older than the configured retention
   * windows. Throttled to once every five minutes.
   */
  maybeMaintenanceLogs(): Promise<void>;
};

/**
 * Build a diagnostics recorder bound to the given logger. The recorder
 * owns the maintenance throttle clock and the logger used to warn on failures.
 * All file/process work is delegated to module-scope helpers.
 */
export function createDiagnosticsRecorder(
  logger: FastifyBaseLogger
): DiagnosticsRecorder {
  let lastLogMaintenanceAt = -Infinity;

  return {
    async maybeMaintenanceLogs(): Promise<void> {
      const now = Date.now();
      if (now - lastLogMaintenanceAt < LOG_MAINTENANCE_INTERVAL_MS) {
        return;
      }
      lastLogMaintenanceAt = now;

      try {
        // Rotate the launcher-selected log via copytruncate (keep 3 bounded tails)
        const logPath = serverLogPath();
        await copyTruncateFile(logPath, 3);

        // Delete old diagnostics JSON files (> 7 days)
        await deleteOldFiles(
          diagnosticsRoot(),
          /\.json$/,
          DIAGNOSTICS_MAX_AGE_MS
        );

        // Delete old rotated server logs (> 14 days)
        await deleteOldFiles(
          path.dirname(logPath),
          isMacAppManaged() ? /^server\.log\.\d+$/ : /^dispatch\.log\.\d+$/,
          SERVER_LOG_MAX_AGE_MS
        );
      } catch (error) {
        logger.warn({ err: error }, "Log maintenance failed.");
      }
    },
  };
}
