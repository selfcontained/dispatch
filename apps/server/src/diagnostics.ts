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

import { runCommand } from "./shared/lib/run-command.js";

const TMUX_INVENTORY_INTERVAL_MS = 60_000;
const LOG_MAINTENANCE_INTERVAL_MS = 5 * 60_000;
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const DIAGNOSTICS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SERVER_LOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export type MissingSessionIncident = {
  agentId: string;
  tmuxSession: string;
  status: string;
  updatedAt: string;
  exitInfo: number | null;
};

export type DiagnosticsRecorder = {
  /**
   * Append a tmux session/pane snapshot to the rotating inventory log.
   * Throttled to once per minute — calling more often is a no-op so the
   * reconciler can call it on every tick without worrying about rate.
   */
  maybeCaptureTmuxInventory(): Promise<void>;

  /**
   * Rotate the inventory log + the dispatch server log when they exceed
   * 10 MB, and prune diagnostic JSON / rotated log files older than the
   * configured retention windows. Throttled to once every five minutes.
   */
  maybeMaintenanceLogs(): Promise<void>;

  /**
   * One-shot capture invoked when reconciliation finds a tmux session
   * missing for an agent that should still be running. Writes a single
   * timestamped JSON file with the tmux state, process list, and (on
   * macOS) launchd state. Not throttled — incidents are rare enough
   * that we want every one captured.
   */
  captureMissingSessionIncident(input: MissingSessionIncident): Promise<void>;
};

/**
 * Build a diagnostics recorder bound to the given logger. The throttle
 * clocks live inside the closure rather than module-level state so each
 * call to this factory yields a fresh recorder (useful for tests).
 */
export function createDiagnosticsRecorder(
  logger: FastifyBaseLogger
): DiagnosticsRecorder {
  let lastTmuxInventoryAt = 0;
  let lastLogMaintenanceAt = 0;

  const diagnosticsRoot = (): string =>
    path.join(os.homedir(), ".dispatch", "diagnostics");

  const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : "Unknown error";

  // Wrapper that swallows runCommand failures into a structured result so
  // the diagnostic capture can record partial state instead of aborting.
  const captureCommand = async (
    command: string,
    args: string[],
    allowedExitCodes: number[]
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    try {
      return await runCommand(command, args, { allowedExitCodes });
    } catch (error) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: errorMessage(error),
      };
    }
  };

  const detectTmuxServerPid = async (): Promise<number | null> => {
    const processes = await captureCommand("ps", ["-axo", "pid=,comm="], [0]);
    if (processes.exitCode !== 0) {
      return null;
    }
    const pidLine = processes.stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => /\btmux$/.test(line));
    if (!pidLine) {
      return null;
    }
    const [pidText] = pidLine.split(/\s+/, 1);
    const pid = Number(pidText);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  };

  /** Rotate by renaming: file -> file.1, file.1 -> file.2, etc. */
  const rotateFile = async (
    filePath: string,
    maxBackups: number
  ): Promise<void> => {
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
  };

  /** Copy then truncate in-place (preserves open file descriptors like launchd's). */
  const copyTruncateFile = async (
    filePath: string,
    maxBackups: number
  ): Promise<void> => {
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

    // Copy current to .1, then truncate in place.
    // Small data-loss window between copy and truncate (same as logrotate copytruncate). Acceptable for diagnostic logs.
    await copyFile(filePath, `${filePath}.1`);
    const fh = await open(filePath, "r+");
    try {
      await fh.truncate(0);
    } finally {
      await fh.close();
    }
  };

  /** Delete files matching a pattern that are older than maxAgeMs. */
  const deleteOldFiles = async (
    dir: string,
    pattern: RegExp,
    maxAgeMs: number
  ): Promise<void> => {
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
  };

  return {
    async maybeCaptureTmuxInventory(): Promise<void> {
      const now = Date.now();
      if (now - lastTmuxInventoryAt < TMUX_INVENTORY_INTERVAL_MS) {
        return;
      }
      lastTmuxInventoryAt = now;

      try {
        await mkdir(diagnosticsRoot(), { recursive: true });
        const payload = {
          capturedAt: new Date(now).toISOString(),
          source: "reconcile",
          tmux: {
            serverPid: await detectTmuxServerPid(),
            sessions: await captureCommand(
              "tmux",
              ["list-sessions", "-F", "#{session_name}:#{session_created}"],
              [0, 1]
            ),
            panes: await captureCommand(
              "tmux",
              [
                "list-panes",
                "-a",
                "-F",
                "#{session_name}:#{window_name}:#{pane_id}:#{pane_pid}:#{pane_current_command}",
              ],
              [0, 1]
            ),
          },
        };
        await appendFile(
          path.join(diagnosticsRoot(), "tmux-inventory.jsonl"),
          `${JSON.stringify(payload)}\n`,
          "utf-8"
        );
      } catch (error) {
        logger.warn({ err: error }, "Failed to capture tmux inventory.");
      }
    },

    async captureMissingSessionIncident(
      input: MissingSessionIncident
    ): Promise<void> {
      try {
        await mkdir(diagnosticsRoot(), { recursive: true });
        const capturedAt = new Date().toISOString();
        const safeTs = capturedAt.replaceAll(":", "-");
        const payload = {
          capturedAt,
          incident: "missing_tmux_session",
          agent: input,
          tmux: {
            serverPid: await detectTmuxServerPid(),
            sessions: await captureCommand(
              "tmux",
              ["list-sessions", "-F", "#{session_name}:#{session_created}"],
              [0, 1]
            ),
            panes: await captureCommand(
              "tmux",
              [
                "list-panes",
                "-a",
                "-F",
                "#{session_name}:#{window_name}:#{pane_id}:#{pane_pid}:#{pane_current_command}",
              ],
              [0, 1]
            ),
          },
          processes: await captureCommand(
            "ps",
            ["-axo", "pid,ppid,pgid,user,command"],
            [0]
          ),
          launchctl: await captureCommand(
            "launchctl",
            ["print", `gui/${process.getuid?.() ?? -1}/com.dispatch.server`],
            [0, 113]
          ),
        };
        const fileName = `${safeTs}-missing-session-${input.agentId}.json`;
        await writeFile(
          path.join(diagnosticsRoot(), fileName),
          JSON.stringify(payload, null, 2),
          "utf-8"
        );
      } catch (error) {
        logger.warn(
          { err: error, agentId: input.agentId },
          "Failed to capture missing tmux session incident."
        );
      }
    },

    async maybeMaintenanceLogs(): Promise<void> {
      const now = Date.now();
      if (now - lastLogMaintenanceAt < LOG_MAINTENANCE_INTERVAL_MS) {
        return;
      }
      lastLogMaintenanceAt = now;

      try {
        // Rotate tmux-inventory.jsonl (keep 1 backup)
        const inventoryPath = path.join(
          diagnosticsRoot(),
          "tmux-inventory.jsonl"
        );
        await rotateFile(inventoryPath, 1);

        // Rotate dispatch.log via copytruncate (keep 3 backups)
        const serverLogPath = path.join(
          os.homedir(),
          ".dispatch",
          "logs",
          "dispatch.log"
        );
        await copyTruncateFile(serverLogPath, 3);

        // Delete old diagnostics JSON files (> 7 days)
        await deleteOldFiles(
          diagnosticsRoot(),
          /\.json$/,
          DIAGNOSTICS_MAX_AGE_MS
        );

        // Delete old rotated logs (inventory backups > 7 days, server log backups > 14 days)
        await deleteOldFiles(
          diagnosticsRoot(),
          /tmux-inventory\.jsonl\.\d+$/,
          DIAGNOSTICS_MAX_AGE_MS
        );
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
