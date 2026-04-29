import { readFile, writeFile } from "node:fs/promises";

import type { FastifyBaseLogger } from "fastify";

import { runCommand } from "../../shared/lib/run-command.js";
import type { AgentRuntime, LaunchInput } from "../runtime.js";

/** TTL for the per-session current-cwd cache. */
const CWD_CACHE_TTL_MS = 10_000;

/** Grace period between Ctrl-C and kill-session in non-force stop. */
const STOP_GRACE_MS = 1200;

/** Hard timeout for individual `tmux display-message` / `pgrep` / `ps` / `lsof` calls. */
const PROCESS_INSPECT_TIMEOUT_MS = 800;

/** Basenames the cwd resolver recognises as "the agent CLI" (worth pid-walking into). */
const AGENT_CLI_BASENAMES = new Set(["claude", "codex", "opencode"]);

/**
 * Build the tmux-backed AgentRuntime. Holds a per-session cwd cache in
 * its closure (TTL `CWD_CACHE_TTL_MS`) — the cache is what stops the
 * UI from spawning a fresh `tmux display-message` + `pgrep` + `ps` +
 * `lsof` chain on every reconcile tick.
 */
export function createTmuxRuntime(logger: FastifyBaseLogger): AgentRuntime {
  const cwdCache = new Map<string, { value: string; expiresAt: number }>();

  return {
    async launch(input: LaunchInput): Promise<void> {
      const wrappedCommand = await preparePayload(input);

      await runCommand("tmux", [
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
      fallback,
    }: {
      sessionName: string;
      agentId: string;
      fallback: string;
    }): Promise<string> {
      const session = sessionName.trim();
      if (!session) return fallback;

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
          return fallback;
        }
        cwdCache.set(cacheKey, {
          value: cwd,
          expiresAt: now + CWD_CACHE_TTL_MS,
        });
        return cwd;
      } catch {
        return fallback;
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
        const content = await readFile(
          `/tmp/dispatch_${sessionName}.exit`,
          "utf-8"
        );
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
 * Translate a `LaunchInput.payload` into the bash invocation that tmux
 * will run inside `new-session`. For setup-script payloads, write the
 * script to disk first; for inline agent-command payloads, wrap with
 * stderr-tee + exit-capture so the reconciler can read the result.
 */
async function preparePayload(input: LaunchInput): Promise<string> {
  const { payload } = input;

  if (payload.kind === "setup-script") {
    await writeFile(payload.scriptPath, payload.scriptContent, { mode: 0o755 });
    return `bash ${payload.scriptPath}`;
  }

  // agent-command: wrap so stderr is tee'd to the setup log and exit
  // code is captured for the reconciler.
  const sessionLogFile = `/tmp/dispatch_setup_${input.agentId}.log`;
  return `bash -c 'exec 2> >(tee "${sessionLogFile}" >&2); ${payload.command.replaceAll(
    "'",
    "'\\''"
  )}; echo "EXIT:$?" > ${payload.exitFile}'`;
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
  const logPath = `/tmp/dispatch_setup_${idOrSession}.log`;
  try {
    const log = await readFile(logPath, "utf-8");
    const tail = log.trim().split("\n").slice(-20).join("\n");
    if (tail) return `\n\nSetup log (last 20 lines):\n${tail}`;
  } catch {
    /* no log file */
  }
  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
