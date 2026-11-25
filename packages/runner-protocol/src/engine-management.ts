import {
  operations,
  type Req,
  type Json,
  type RunnerError,
} from "./contract/index.js";
import type { RunnerEngine } from "./execution.js";
import { isRecord } from "./validation.js";

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

/** Optional runner-wide operations negotiated with engineCapabilities. */
export type EngineCapabilityOperation =
  | { type: "model_catalog"; engine: RunnerEngine; model?: string }
  | { type: "provider_usage" }
  | { type: "codex_reset"; account: string; requestId: string }
  | {
      type: "plugin_status" | "plugin_install" | "plugin_update";
      engine: "claude" | "codex";
      /** An operator-provisioned plugin identifier. */
      plugin: string;
    };

export type EngineChoice = { value: string; name: string };
export type EngineModelCatalog = {
  defaultModel: string | null;
  models: Array<{ id: string; label: string; effort?: EngineChoice[] }>;
};

export type EngineProviderUsage = {
  checkedAt: string;
  providers: Array<{
    engine: "claude" | "codex";
    plan: string | null;
    observedAt: string | null;
    source?: "live" | "local";
    windows: Array<{
      id: string;
      label: string;
      usedPercent: number;
      resetsAt: string | null;
    }>;
    limitReached?: boolean;
    spend?: {
      used: number;
      limit: number;
      currency: string;
      enabled?: boolean;
    };
    credits?: { balance: number | null; unlimited: boolean };
    limitResets?: { available: number; applicable: number };
    unavailableReason?: string;
  }>;
  /** Opaque precondition for redeeming against the reported Codex login. */
  codexResetAccount?: string;
};

export type EnginePluginStatus = {
  agentType?: "claude" | "codex";
  detectionError?: string;
  installed: boolean;
  enabled: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  actions: Array<"install" | "update">;
};

export type EngineCapabilityResult =
  | { type: "model_catalog"; catalog: EngineModelCatalog }
  | { type: "provider_usage"; usage: EngineProviderUsage }
  | { type: "codex_reset"; code: string; windowsReset: number }
  | { type: "plugin_status"; status: EnginePluginStatus };

export function isEngineCapabilityOperation(
  operation: EngineOperation
): operation is EngineCapabilityOperation {
  return (
    operation.type === "model_catalog" ||
    operation.type === "provider_usage" ||
    operation.type === "codex_reset" ||
    operation.type === "plugin_status" ||
    operation.type === "plugin_install" ||
    operation.type === "plugin_update"
  );
}

/** Current engine calls use the existing authenticated engine request envelope. */
export const ENGINE_HOST_CALLS = [
  "engine.list",
  "engine.login.start",
  "engine.login.submit",
  "engine.login.status",
  "engine.login.cancel",
  "engine.update.inspect",
  "engine.update.spawn",
  "engine.update.release",
  "engine.update.probe",
  "engine.operation",
  "engine.plugin.status",
  "engine.plugin.apply",
] as const;
export type EngineHostCallName = (typeof ENGINE_HOST_CALLS)[number];
export type EngineHostCall = {
  [K in EngineHostCallName]: { op: K; request: Req<K> };
}[EngineHostCallName];
export function isEngineHostCall(value: unknown): value is EngineHostCall {
  return (
    isRecord(value) &&
    typeof value.op === "string" &&
    (ENGINE_HOST_CALLS as readonly string[]).includes(value.op) &&
    operations[value.op as EngineHostCallName].request.check(value.request)
  );
}

export type EngineOperation =
  | EngineCapabilityOperation
  | { type: "contract"; call: EngineHostCall }
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
      result?: Json;
      ranCommands?: string[];
      probeFailed?: boolean;
      operationId?: string;
      capability?: EngineCapabilityResult;
      login?: EngineLoginView;
      /** e.g. "Already up to date (version 1.2.3)." — never raw CLI output. */
      message?: string;
    }
  | {
      ok: false;
      error: string;
      failure?: RunnerError;
      status?: EnginePluginStatus;
      ranCommands?: string[];
      probeFailed?: boolean;
      unsupported?: boolean;
      reason?: "account_changed";
    };

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

export function isRunnerEngine(value: unknown): value is RunnerEngine {
  return RUNNER_ENGINES.some((engine) => engine === value);
}

export function isEngineOperation(value: unknown): value is EngineOperation {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "contract":
      return isEngineHostCall(value.call);
    case "status":
    case "provider_usage":
      return true;
    case "model_catalog":
      return (
        isRunnerEngine(value.engine) &&
        (value.model === undefined ||
          (typeof value.model === "string" &&
            /^[\w./:@+\[\]-]{1,160}$/.test(value.model)))
      );
    case "codex_reset":
      return (
        typeof value.account === "string" &&
        /^[A-Za-z0-9_-]{1,128}$/.test(value.account) &&
        typeof value.requestId === "string" &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.requestId)
      );
    case "plugin_status":
    case "plugin_install":
    case "plugin_update":
      return (
        (value.engine === "claude" || value.engine === "codex") &&
        typeof value.plugin === "string" &&
        /^[\w-]{1,48}@[\w-]{1,48}$/.test(value.plugin)
      );
    case "install":
    case "update":
      return isRunnerEngine(value.engine);
    case "login_start":
      return (
        isRunnerEngine(value.engine) &&
        (value.restart === undefined || typeof value.restart === "boolean")
      );
    case "login_submit":
      return (
        typeof value.loginId === "string" && typeof value.code === "string"
      );
    case "login_cancel":
    case "login_status":
      return typeof value.loginId === "string";
    default:
      return false;
  }
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
