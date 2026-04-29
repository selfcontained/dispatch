import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "../config.js";

import { createTmuxRuntime } from "./tmux/runtime.js";

/**
 * What the manager hands to `runtime.launch()` to start (or restart) a
 * session. Two payload flavors:
 *
 * - `setup-script`: write a bash script and run it inside the session.
 *   Used by createAgent — the script handles worktree creation, .env
 *   copy, deps install, and finally execs into the agent CLI itself.
 * - `agent-command`: run a single bash command inside the session.
 *   Used by startAgent (restart) since the worktree already exists.
 *
 * Conspicuously absent from the payload: file paths, log paths, exit
 * files. Those are runtime-owned implementation details — the manager
 * supplies *what to run*, the runtime decides *where to write artifacts
 * and how to capture exit codes*. Diagnostic readouts come back through
 * `readSetupLogTail` / `readExitInfo`, which know the runtime's own
 * conventions.
 */
export type LaunchInput = {
  sessionName: string;
  cwd: string;
  agentId: string;
  payload:
    | { kind: "setup-script"; scriptContent: string }
    | { kind: "agent-command"; command: string };
};

/**
 * Abstraction over "where the agent's process lives." The two
 * implementations — `TmuxRuntime` and `InertRuntime` — let the manager
 * write a single launch/stop/inspect flow that doesn't have to branch
 * on `config.agentRuntime` at every call site.
 *
 * Methods report runtime *facts*, not policy. When a runtime can't
 * answer something honestly (e.g. inert mode has no session state, no
 * pid to walk), it returns `false` / `null` / `[]` rather than fabricating
 * a soft default. The manager applies its own fallback / reconciliation
 * policy on top — see `tracksSessions()` for the explicit capability
 * predicate the reconciler uses to decide when missing-session means
 * "agent died" vs. "this runtime has no notion of session state."
 */
export type AgentRuntime = {
  /**
   * Whether this runtime backs sessions with real OS state that can be
   * polled. `true` for tmux (sessions are processes that can crash);
   * `false` for inert (no sessions exist; the manager's DB is the only
   * source of truth).
   *
   * The reconciler uses this to decide whether `hasSession() === false`
   * means "agent died, transition to stopped" vs. "this runtime can't
   * tell, leave the DB row alone." Synchronous because it's a static
   * capability declared at runtime construction time, not state.
   */
  tracksSessions(): boolean;

  /** Start (or fast-fail) a new session. Throws on launch failure. */
  launch(input: LaunchInput): Promise<void>;
  /**
   * Kill a session if one already exists at this name. No-op when the
   * runtime has nothing to collide with.
   */
  ensureNoExistingSession(sessionName: string): Promise<void>;
  /**
   * Tear down a session. When `force=false`, sends Ctrl-C and waits a
   * short grace period before kill — gives the agent CLI a chance to
   * flush state. `force=true` skips the grace.
   */
  stopSession(sessionName: string, force: boolean): Promise<void>;
  /**
   * Whether a session currently exists by this name. In runtimes that
   * don't track session state (`tracksSessions() === false`), this
   * returns `false` for everything — callers should consult
   * `tracksSessions()` before drawing conclusions from a `false` result.
   */
  hasSession(sessionName: string): Promise<boolean>;
  /**
   * Best-effort current working directory of the agent process inside
   * `sessionName`. Returns `null` when the runtime cannot determine the
   * cwd (no session-state tracking, probe failed, no agent CLI in the
   * pane, etc.) so callers can apply their own fallback explicitly.
   */
  getCurrentCwd(args: {
    sessionName: string;
    agentId: string;
  }): Promise<string | null>;
  /**
   * List sessions whose names start with `prefix`. Used by the
   * reconciler to find orphaned sessions. Returns `[]` in runtimes that
   * don't track session state.
   */
  listSessions(
    prefix: string
  ): Promise<Array<{ name: string; createdAt: number }>>;
  /** Kill a single session by name. Errors are swallowed. */
  killSession(sessionName: string): Promise<void>;
  /**
   * Read the recorded exit code for a session that has terminated. The
   * runtime owns the storage convention (e.g. tmux runtime captures
   * `EXIT:N` to a temp file via the launch wrapper). Returns `null` if
   * no record exists or the runtime doesn't capture exits.
   */
  readExitInfo(sessionName: string): Promise<number | null>;
  /**
   * Tail of the session's stderr log, formatted for inclusion in error
   * messages. Returns the empty string when no log exists or the
   * runtime doesn't capture stderr.
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
 * Inert runtime: no real sessions, no process state, no exit codes.
 * Methods report runtime facts honestly — `hasSession` returns `false`
 * because no sessions exist; callers that want "agent is logically
 * registered" semantics should consult `tracksSessions()` first
 * (returns `false`) and fall back to the agent's DB row.
 */
function createInertRuntime(): AgentRuntime {
  return {
    tracksSessions(): boolean {
      return false;
    },
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
    async hasSession(): Promise<boolean> {
      // No real sessions exist in inert mode. The manager checks
      // `tracksSessions()` before treating `false` as "agent died."
      return false;
    },
    async getCurrentCwd(): Promise<string | null> {
      return null;
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
