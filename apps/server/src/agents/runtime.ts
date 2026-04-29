import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "../config.js";

import { createTmuxRuntime } from "./tmux/runtime.js";

/**
 * What the manager hands to `runtime.launch()` to start (or restart) a
 * session. Two payload flavors:
 *
 * - `setup-script`: write a bash script to disk and run `bash <path>`
 *   inside the session. Used by createAgent — the script handles
 *   worktree creation, .env copy, deps install, and finally execs into
 *   the agent CLI itself.
 * - `agent-command`: run a single bash command inside the session,
 *   wrapped with stderr-tee + exit-code capture. Used by startAgent
 *   (restart) since the worktree already exists.
 *
 * The runtime is responsible for the `bash -c …` wrapping and for
 * post-launch fast-fail detection (verifying the session actually
 * exists after `tmux new-session`).
 */
export type LaunchInput = {
  sessionName: string;
  cwd: string;
  agentId: string;
  payload:
    | { kind: "setup-script"; scriptPath: string; scriptContent: string }
    | { kind: "agent-command"; command: string; exitFile: string };
};

/**
 * Abstraction over "where the agent's process lives." The two
 * implementations — `TmuxRuntime` and `InertRuntime` — let the manager
 * write a single launch/stop/inspect flow that doesn't have to branch
 * on `config.agentRuntime` at every call site.
 *
 * In tmux mode, sessions are real `tmux` sessions and these methods
 * shell out to `tmux` / `pgrep` / `lsof` etc. In inert mode (used by
 * tests and headless environments), most operations are no-ops:
 * `hasSession` returns true for any non-empty name (preserves the
 * legacy "any registered agent is considered live" contract),
 * `listSessions` returns empty, and the diagnostic readers return
 * empty/null.
 */
export type AgentRuntime = {
  /** Start (or fast-fail) a new session. Throws on launch failure. */
  launch(input: LaunchInput): Promise<void>;
  /**
   * Kill a session if one already exists at this name. No-op in inert
   * mode (no tmux state to collide with).
   */
  ensureNoExistingSession(sessionName: string): Promise<void>;
  /**
   * Tear down a session. When `force=false`, sends Ctrl-C and waits a
   * short grace period before kill — gives the agent CLI a chance to
   * flush state. `force=true` skips the grace.
   */
  stopSession(sessionName: string, force: boolean): Promise<void>;
  /** Whether a session currently exists by this name. */
  hasSession(sessionName: string): Promise<boolean>;
  /**
   * Best-effort current working directory of the agent process inside
   * `sessionName`. tmux mode walks pane → child PIDs → lsof. Returns
   * `fallback` on any failure or in inert mode.
   */
  getCurrentCwd(args: {
    sessionName: string;
    agentId: string;
    fallback: string;
  }): Promise<string>;
  /**
   * List sessions whose names start with `prefix`. Used by the
   * reconciler to find orphaned tmux sessions. Returns empty in inert
   * mode (nothing to list).
   */
  listSessions(
    prefix: string
  ): Promise<Array<{ name: string; createdAt: number }>>;
  /** Kill a single session by name. Errors are swallowed. */
  killSession(sessionName: string): Promise<void>;
  /**
   * Read the recorded exit code for a session that has terminated.
   * tmux runtime parses `/tmp/dispatch_<session>.exit` (the launch
   * wrapper writes `EXIT:N` there). Returns `null` if no record
   * exists or in inert mode.
   */
  readExitInfo(sessionName: string): Promise<number | null>;
  /**
   * Tail of the session's stderr log, formatted for inclusion in error
   * messages. Returns the empty string when no log exists or in inert
   * mode.
   */
  readSetupLogTail(idOrSession: string): Promise<string>;
};

/**
 * Build the runtime appropriate for the current config. The factory
 * dispatches once at construction time so the manager doesn't have to
 * branch on `config.agentRuntime` afterward.
 */
export function createAgentRuntime(
  config: AppConfig,
  logger: FastifyBaseLogger
): AgentRuntime {
  if (config.agentRuntime === "inert") {
    return createInertRuntime();
  }
  return createTmuxRuntime(logger);
}

/**
 * Inert runtime: most operations are no-ops because there's no tmux
 * state to manage. `hasSession` returns true for any non-empty name to
 * preserve the legacy "registered agent is live" assumption that the
 * manager's reconciliation logic relies on.
 */
function createInertRuntime(): AgentRuntime {
  return {
    async launch(): Promise<void> {
      // Nothing to do — the manager's inert-mode createAgent path does
      // its workspace setup synchronously before reaching launch.
    },
    async ensureNoExistingSession(): Promise<void> {
      // No tmux state to collide with.
    },
    async stopSession(): Promise<void> {
      // No process to stop.
    },
    async hasSession(sessionName: string): Promise<boolean> {
      return sessionName.trim().length > 0;
    },
    async getCurrentCwd({ fallback }): Promise<string> {
      return fallback;
    },
    async listSessions(): Promise<Array<{ name: string; createdAt: number }>> {
      return [];
    },
    async killSession(): Promise<void> {
      // Nothing to kill.
    },
    async readExitInfo(): Promise<number | null> {
      return null;
    },
    async readSetupLogTail(): Promise<string> {
      return "";
    },
  };
}
