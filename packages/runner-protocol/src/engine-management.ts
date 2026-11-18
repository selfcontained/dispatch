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
  | { type: "login_cancel"; loginId: string };

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
  | { ok: true; operationId?: string; login?: EngineLoginView }
  | { ok: false; error: string; unsupported?: boolean };

export const RUNNER_ENGINES: readonly RunnerEngine[] = [
  "claude",
  "codex",
  "opencode",
];

/** Where an engine's CLI runs: this machine, or a named runner workspace. */
export type EngineScope =
  | { kind: "local" }
  | { kind: "runner"; runnerId: string; workspace: string };

/** A stable string key for a scope, for query params, cache keys and event names. */
export function engineScopeKey(scope: EngineScope): string {
  return scope.kind === "local"
    ? "local"
    : `runner:${scope.runnerId}/${scope.workspace}`;
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
    type === "login_cancel"
  );
}
