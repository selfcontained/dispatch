import { readFile, writeFile } from "node:fs/promises";

import type { FastifyBaseLogger } from "fastify";

import { runCommand } from "../../shared/lib/run-command.js";
import { sleep } from "../../shared/lib/sleep.js";
import type { AgentRuntime, LaunchInput } from "../runtime.js";

/** TTL for the per-session current-cwd cache. */
const CWD_CACHE_TTL_MS = 10_000;

/** Grace period between Ctrl-C and kill-session in non-force stop. */
const STOP_GRACE_MS = 1200;

/** Hard timeout for individual `tmux display-message` / `pgrep` / `ps` / `lsof` calls. */
const PROCESS_INSPECT_TIMEOUT_MS = 800;

/** Basenames the cwd resolver recognises as "the agent CLI" (worth pid-walking into). */
const AGENT_CLI_BASENAMES = new Set([
  "claude",
  "codex",
  "opencode",
  "cursor",
  "agent",
]);

// ── Path conventions (runtime-internal) ─────────────────────────────────
//
// The tmux runtime owns these conventions. The manager only ever asks for
// `readSetupLogTail(idOrSession)` / `readExitInfo(sessionName)` and gets
// back the contents — it doesn't have to know where the files live.

const setupScriptPath = (agentId: string): string =>
  `/tmp/dispatch_setup_${agentId}.sh`;
const setupLogPath = (idOrSession: string): string =>
  `/tmp/dispatch_setup_${idOrSession}.log`;
const exitFilePath = (sessionName: string): string =>
  `/tmp/dispatch_${sessionName}.exit`;

/**
 * Build the tmux-backed AgentRuntime. Holds a per-session cwd cache in
 * its closure (TTL `CWD_CACHE_TTL_MS`) — the cache is what stops the
 * UI from spawning a fresh `tmux display-message` + `pgrep` + `ps` +
 * `lsof` chain on every reconcile tick.
 */
export function createTmuxRuntime(logger: FastifyBaseLogger): AgentRuntime {
  const cwdCache = new Map<string, { value: string; expiresAt: number }>();

  return {
    tracksSessions(): boolean {
      return true;
    },

    async launch(input: LaunchInput): Promise<void> {
      const wrappedCommand = await prepareLaunch(input);

      await runCommand("tmux", [
        "-u",
        "new-session",
        "-d",
        "-s",
        input.sessionName,
        "-c",
        input.cwd,
        wrappedCommand,
      ]);

      // Quiet the status bar — agent CLIs draw their own UI.
      await runCommand(
        "tmux",
        ["set-option", "-t", input.sessionName, "status", "off"],
        { allowedExitCodes: [0, 1] }
      );
      // ⚠️ CRITICAL — DO NOT remove or gate this without explicit
      // instruction. Tmux scroll is critical functionality.
      //
      // Enable mouse mode at session creation so wheel/touch scroll
      // forwards to tmux as SGR mouse codes. This is required for any
      // scroll on mobile (xterm has no native touch handling) and is
      // load-bearing for desktop wheel scroll inside tmux's alternate
      // screen too. Setting it once at launch keeps it independent of
      // the copy-mode-assist toggle, which historically tied scroll to
      // the toggle's on-state and silently broke scroll for everyone
      // who left it off. The toggle controls *only* the banner UI / the
      // passive copy-mode observer — never scroll plumbing.
      await runCommand(
        "tmux",
        ["set-option", "-t", input.sessionName, "mouse", "on"],
        { allowedExitCodes: [0, 1] }
      );
      // Allow DCS passthrough so agent CLIs that wrap escape sequences
      // (e.g. synchronized output) can reach the outer terminal directly.
      await runCommand(
        "tmux",
        ["set-option", "-t", input.sessionName, "allow-passthrough", "on"],
        { allowedExitCodes: [0, 1] }
      );
      // Advertise synchronized output support so tmux wraps frame
      // rendering in DEC 2026 sequences, reducing terminal flashing.
      // Set once per session start (not per WebSocket attach) to avoid
      // unbounded array growth.
      await runCommand(
        "tmux",
        ["set-option", "-as", "terminal-features", "xterm-256color:sync"],
        { allowedExitCodes: [0, 1] }
      );

      // Detect fast-fail launches (e.g. missing CLI executable, broken
      // profile script) so the agent isn't left as "running" with no
      // backing tmux session.
      if (!(await tmuxHasSession(input.sessionName))) {
        const detail = await readSetupLogTailFromDisk(input.agentId);
        throw new Error(
          `tmux session exited immediately after launch${detail}`
        );
      }
    },

    async ensureNoExistingSession(sessionName: string): Promise<void> {
      if (await tmuxHasSession(sessionName)) {
        await runCommand("tmux", ["kill-session", "-t", sessionName]);
      }
    },

    async stopSession(sessionName: string, force: boolean): Promise<void> {
      if (!force) {
        await runCommand("tmux", ["send-keys", "-t", sessionName, "C-c"]);
        await sleep(STOP_GRACE_MS);
      }

      if (await tmuxHasSession(sessionName)) {
        await runCommand("tmux", ["kill-session", "-t", sessionName]);
      }
    },

    async hasSession(sessionName: string): Promise<boolean> {
      return tmuxHasSession(sessionName);
    },

    async getCurrentCwd({
      sessionName,
      agentId,
    }: {
      sessionName: string;
      agentId: string;
    }): Promise<string | null> {
      const session = sessionName.trim();
      if (!session) return null;

      const cacheKey = `${agentId}:${session}`;
      const cached = cwdCache.get(cacheKey);
      const now = Date.now();
      if (cached && cached.expiresAt > now) {
        return cached.value;
      }

      try {
        // First, try the agent CLI process itself. tmux pane_current_path
        // only tracks the shell's CWD, but agent CLIs (claude, codex,
        // opencode) may cd internally without updating the shell.
        const agentCwd = await resolveAgentProcessCwd(session, logger);
        if (agentCwd) {
          cwdCache.set(cacheKey, {
            value: agentCwd,
            expiresAt: now + CWD_CACHE_TTL_MS,
          });
          return agentCwd;
        }

        // Fall back to tmux pane_current_path (the shell's CWD).
        const result = await runCommand(
          "tmux",
          ["display-message", "-p", "-t", session, "#{pane_current_path}"],
          {
            allowedExitCodes: [0, 1],
            timeoutMs: PROCESS_INSPECT_TIMEOUT_MS,
          }
        );
        const cwd = result.stdout.trim();
        if (result.exitCode !== 0 || !cwd) {
          return null;
        }
        cwdCache.set(cacheKey, {
          value: cwd,
          expiresAt: now + CWD_CACHE_TTL_MS,
        });
        return cwd;
      } catch {
        return null;
      }
    },

    async listSessions(
      prefix: string
    ): Promise<Array<{ name: string; createdAt: number }>> {
      let stdout: string | undefined;
      try {
        const result = await runCommand(
          "tmux",
          ["list-sessions", "-F", "#{session_name}:#{session_created}"],
          { allowedExitCodes: [0, 1] }
        );
        stdout = result.stdout;
      } catch {
        // tmux not running or no sessions
        return [];
      }

      if (!stdout?.trim()) return [];

      return stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const colonIdx = line.lastIndexOf(":");
          const name = line.substring(0, colonIdx);
          const createdStr = line.substring(colonIdx + 1);
          return { name, createdAt: parseInt(createdStr, 10) };
        })
        .filter((s) => s.name.startsWith(prefix));
    },

    async killSession(sessionName: string): Promise<void> {
      await runCommand("tmux", ["kill-session", "-t", sessionName]).catch(
        () => {}
      );
    },

    async readExitInfo(sessionName: string): Promise<number | null> {
      try {
        const content = await readFile(exitFilePath(sessionName), "utf-8");
        const match = content.trim().match(/^EXIT:(\d+)$/);
        return match ? Number(match[1]) : null;
      } catch {
        return null;
      }
    },

    async readSetupLogTail(idOrSession: string): Promise<string> {
      return readSetupLogTailFromDisk(idOrSession);
    },
  };
}

/**
 * Translate a `LaunchInput` into the bash invocation that tmux runs
 * inside `new-session`. Both payload kinds get the same outer wrapper
 * — stderr tee'd to the per-agent setup log, exit code captured to the
 * per-session exit file — so the reconciler can read both via
 * `readSetupLogTail` and `readExitInfo` regardless of how the session
 * was launched.
 */
async function prepareLaunch(input: LaunchInput): Promise<string> {
  let inner: string;
  if (input.payload.kind === "setup-script") {
    const scriptPath = setupScriptPath(input.agentId);
    await writeFile(scriptPath, input.payload.scriptContent, { mode: 0o755 });
    inner = `bash ${scriptPath}`;
  } else {
    inner = input.payload.command;
  }

  const logFile = setupLogPath(input.agentId);
  const exitFile = exitFilePath(input.sessionName);
  const escapedInner = inner.replaceAll("'", "'\\''");
  return `bash -c 'exec 2> >(tee "${logFile}" >&2); ${escapedInner}; echo "EXIT:$?" > ${exitFile}'`;
}

async function tmuxHasSession(sessionName: string): Promise<boolean> {
  const result = await runCommand("tmux", ["has-session", "-t", sessionName], {
    allowedExitCodes: [0, 1],
  });
  return result.exitCode === 0;
}

/**
 * Resolve the CWD of the agent CLI process (claude/codex/opencode)
 * running inside a tmux pane. The CLI process may have cd'd into a
 * worktree internally, which tmux's `pane_current_path` won't reflect.
 *
 * Walks: pane PID → child PIDs (pgrep) → matching basename (ps) →
 * cwd (lsof -d cwd -Fn). Returns null on any failure.
 */
async function resolveAgentProcessCwd(
  session: string,
  logger: FastifyBaseLogger
): Promise<string | null> {
  try {
    const pidResult = await runCommand(
      "tmux",
      ["display-message", "-p", "-t", session, "#{pane_pid}"],
      { allowedExitCodes: [0, 1], timeoutMs: PROCESS_INSPECT_TIMEOUT_MS }
    );
    const panePid = pidResult.stdout.trim();
    if (pidResult.exitCode !== 0 || !panePid) {
      logger.debug({ session }, "resolveAgentProcessCwd: no pane_pid");
      return null;
    }

    const childrenResult = await runCommand("pgrep", ["-P", panePid], {
      allowedExitCodes: [0, 1],
      timeoutMs: PROCESS_INSPECT_TIMEOUT_MS,
    });
    if (childrenResult.exitCode !== 0 || !childrenResult.stdout.trim()) {
      logger.debug({ session, panePid }, "resolveAgentProcessCwd: no children");
      return null;
    }

    const childPids = childrenResult.stdout.trim().split("\n");
    let agentPid: string | null = null;

    for (const pid of childPids) {
      const commResult = await runCommand(
        "ps",
        ["-o", "comm=", "-p", pid.trim()],
        {
          allowedExitCodes: [0, 1],
          timeoutMs: PROCESS_INSPECT_TIMEOUT_MS,
        }
      );
      const comm = commResult.stdout.trim();
      const basename = comm.split("/").pop() ?? "";
      if (AGENT_CLI_BASENAMES.has(basename)) {
        agentPid = pid.trim();
        break;
      }
    }

    if (!agentPid) {
      logger.debug(
        { session, panePid },
        "resolveAgentProcessCwd: no agent CLI among children"
      );
      return null;
    }

    // Read the process's CWD via lsof (works on macOS and Linux).
    const lsofResult = await runCommand(
      "lsof",
      ["-a", "-p", agentPid, "-d", "cwd", "-Fn"],
      { allowedExitCodes: [0, 1], timeoutMs: PROCESS_INSPECT_TIMEOUT_MS }
    );
    if (lsofResult.exitCode !== 0 || !lsofResult.stdout) {
      logger.debug(
        { session, agentPid },
        "resolveAgentProcessCwd: lsof failed"
      );
      return null;
    }

    // lsof -Fn outputs lines like "p<pid>" and "n<path>". Extract the path.
    for (const line of lsofResult.stdout.split("\n")) {
      if (line.startsWith("n/")) {
        const cwd = line.slice(1);
        logger.debug(
          { session, agentPid, cwd },
          "resolveAgentProcessCwd: resolved"
        );
        return cwd;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Read the last 20 lines of a setup/session stderr log to include in
 * error messages. Returns "" when no log file is on disk.
 */
async function readSetupLogTailFromDisk(idOrSession: string): Promise<string> {
  const logPath = setupLogPath(idOrSession);
  try {
    const log = await readFile(logPath, "utf-8");
    const tail = log.trim().split("\n").slice(-20).join("\n");
    if (tail) return `\n\nSetup log (last 20 lines):\n${tail}`;
  } catch {
    /* no log file */
  }
  return "";
}
