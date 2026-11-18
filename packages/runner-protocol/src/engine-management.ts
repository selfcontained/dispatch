import type { RunnerEngine } from "./index.js";

/**
 * Engine install/update/sign-in, scoped to wherever an engine's CLI runs:
 * this machine or a named runner workspace. Self-contained wire types; a
 * runner that predates this module simply never answers an `"engine"`
 * command, which callers treat as `{ ok: false, unsupported: true }`.
 */

export type EngineSupportedAction =
  | "install"
  | "update"
  | "login"
  | "login_cancel";

/** What a scope reports about one engine, for an inventory list. */
export type EngineInventoryEntry = {
  id: RunnerEngine;
  label: string;
  installed: boolean;
  /** Null when signed-in status could not be determined (e.g. CLI missing). */
  signedIn: boolean | null;
  version: string | null;
  /** Who it's signed in as, or how; never a token, URL or code. */
  detail?: string;
  /**
   * A short, pre-defined reason an action isn't offered even though it
   * otherwise would be — e.g. `"install-unavailable"` when a configured
   * install/update command's own executable can't run (missing npm/node).
   * Never raw CLI output.
   */
  issue?: string;
  actions: EngineSupportedAction[];
};

/** Mirrors `@dispatch/shared`'s `EngineLogin`, generalized over `RunnerEngine`. */
export type EngineLoginView = {
  id: string;
  engine: RunnerEngine;
  status:
    | "starting"
    | "waiting"
    | "verifying"
    | "succeeded"
    | "failed"
    | "cancelled";
  needsCode: boolean;
  /** The sign-in link; present only while the sign-in is active. */
  url?: string;
  /** Codex's one-time device code; present only while the sign-in is active. */
  userCode?: string;
  detail?: string;
  error?: string;
  expiresAt?: string;
  finishedAt?: string;
};

export type EngineOperation =
  | { type: "status" }
  | { type: "install"; engine: RunnerEngine }
  | { type: "update"; engine: RunnerEngine }
  | { type: "login_start"; engine: RunnerEngine; restart?: boolean }
  | { type: "login_submit"; loginId: string; code: string }
  | { type: "login_cancel"; loginId: string }
  /**
   * Read a sign-in's current view without acting on it — the only way to
   * observe progress that happens after the CLI's output arrived
   * asynchronously (a code being verified, a device flow finishing on its
   * own), since the op that started or answered it already returned.
   */
  | { type: "login_status"; loginId: string };

/**
 * Progress for a long-running operation. Sent as they happen; a scope may
 * send zero or more before its terminal `operation_complete`. `outputChunk`
 * is bounded CLI output for display, never a secret, URL or code — those
 * travel only in `login_update`'s `url`/`userCode`, which are never logged.
 */
export type EngineOperationEvent =
  | { type: "inventory"; entries: EngineInventoryEntry[] }
  | {
      type: "operation_progress";
      operationId: string;
      engine: RunnerEngine;
      phase: string;
      message: string;
      outputChunk?: string;
    }
  | {
      type: "operation_complete";
      operationId: string;
      engine: RunnerEngine;
      success: boolean;
      message: string;
    }
  | { type: "login_update"; login: EngineLoginView };

export type EngineOperationAck =
  | {
      ok: true;
      operationId?: string;
      login?: EngineLoginView;
      /** e.g. "Already up to date (version 1.2.3)." — never raw CLI output. */
      message?: string;
    }
  | { ok: false; error: string; unsupported?: boolean };

export const RUNNER_ENGINES: readonly RunnerEngine[] = [
  "claude",
  "codex",
  "opencode",
];

/**
 * Where an engine's CLI runs: this machine, or a named runner. Runner-wide,
 * not per-workspace — a runner's `bins` (and its install/update commands)
 * are one configuration for the whole runner, not one per workspace.
 */
export type EngineScope =
  | { kind: "local" }
  | { kind: "runner"; runnerId: string };

/** A stable string key for a scope, for query params, cache keys and event names. */
export function engineScopeKey(scope: EngineScope): string {
  return scope.kind === "local" ? "local" : `runner:${scope.runnerId}`;
}

export function isEngineOperation(value: unknown): value is EngineOperation {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === "status" ||
    type === "install" ||
    type === "update" ||
    type === "login_start" ||
    type === "login_submit" ||
    type === "login_cancel" ||
    type === "login_status"
  );
}

const SUPPORTED_ACTIONS = new Set<EngineSupportedAction>([
  "install",
  "update",
  "login",
  "login_cancel",
]);

/**
 * Validate a runner-pushed inventory snapshot before trusting it: bounded
 * length, known engine ids and action names, safe-shaped version/detail
 * strings. A malformed or over-long snapshot is dropped entirely (returns
 * null) rather than partially accepted.
 */
export function parseEngineInventory(
  input: unknown
): EngineInventoryEntry[] | null {
  if (!Array.isArray(input) || input.length > RUNNER_ENGINES.length)
    return null;
  const entries: EngineInventoryEntry[] = [];
  const seen = new Set<RunnerEngine>();
  for (const item of input) {
    if (!item || typeof item !== "object") return null;
    const { id, label, installed, signedIn, version, detail, issue, actions } =
      item as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      !(RUNNER_ENGINES as readonly string[]).includes(id) ||
      seen.has(id as RunnerEngine) ||
      typeof label !== "string" ||
      label.length > 80 ||
      typeof installed !== "boolean" ||
      (signedIn !== null && typeof signedIn !== "boolean") ||
      (version !== null &&
        (typeof version !== "string" || !/^[\w.+-]{1,40}$/.test(version))) ||
      (detail !== undefined &&
        (typeof detail !== "string" || detail.length > 200)) ||
      (issue !== undefined &&
        (typeof issue !== "string" || issue.length > 80)) ||
      !Array.isArray(actions) ||
      actions.length > SUPPORTED_ACTIONS.size ||
      !actions.every(
        (action): action is EngineSupportedAction =>
          typeof action === "string" &&
          SUPPORTED_ACTIONS.has(action as EngineSupportedAction)
      )
    )
      return null;
    seen.add(id as RunnerEngine);
    entries.push({
      id: id as RunnerEngine,
      label,
      installed,
      signedIn: signedIn as boolean | null,
      version: version as string | null,
      ...(detail !== undefined ? { detail } : {}),
      ...(issue !== undefined ? { issue } : {}),
      actions,
    });
  }
  return entries;
}
