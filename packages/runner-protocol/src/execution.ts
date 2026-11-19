import { isCheckoutQuery, type CheckoutQuery } from "./checkout.js";
import { MANAGED_WORKSPACE, isOpaqueId } from "./placement.js";
import {
  type EngineInventoryEntry,
  type EngineOperation,
  isEngineOperation,
  isRunnerEngine,
} from "./engine-management.js";
import type { RunnerHealth } from "./health.js";
import { isHttpUrl, isNullableString, isRecord } from "./validation.js";

export const RUNNER_WIRE_VERSION = 1;

export type RunnerEngine = "claude" | "codex" | "opencode";

export type ServiceMcp = {
  url: string;
  token: string;
  /** Legacy launchers omit the name and use "dispatch". */
  name?: string;
};

export type RepositoryCheckout =
  | { kind: "new"; branch: string; base?: string }
  | { kind: "branch"; branch: string }
  | { kind: "pr"; branch: string; number: number };

export type RunnerRepository = { url: string; checkout: RepositoryCheckout };

/** The guest supplies all machine-local execution settings. */
export type RemoteLaunch = {
  agentId: string;
  engine: RunnerEngine;
  fullAccess?: boolean;
  model: string | null;
  effort?: string | null;
  systemPrompt: string | null;
  personaContext?: string | null;
  mcp?: ServiceMcp;
  resumeSessionId: string | null;
  repository?: RunnerRepository;
  useWorktreeOf?: string;
};

export type SessionOperation = { agentId: string } & (
  | { kind: "launch"; launch: RemoteLaunch }
  | { kind: "inspectCheckout"; query: CheckoutQuery }
  | { kind: "attach" | "alive" | "discard" | "log" | "repo" }
  | { kind: "stop"; force: boolean }
);

export type RunnerOperation = { kind: "engine"; operation: EngineOperation };

/** V1 uses one envelope for both scopes. Runner operations ignore the agent id. */
export type Command = { workspace: string } & (
  | SessionOperation
  | (RunnerOperation & { agentId: string })
);
export type ReadyFrame = {
  type: "ready";
  version: typeof RUNNER_WIRE_VERSION;
  workspaces: string[];
  health?: true;
  managedWorkspace?: true;
  /** Advertises support for the `"engine"` command and inventory push. */
  engineManagement?: true;
  checkoutInspection?: true;
  sharedWorktree?: true;
};

/** Accept v1 extension fields and enable optional features only when explicitly true. */
export function parseReadyFrame(value: unknown): ReadyFrame | null {
  if (!value || typeof value !== "object") return null;
  const frame = value as Record<string, unknown>;
  if (
    frame.type !== "ready" ||
    frame.version !== RUNNER_WIRE_VERSION ||
    !Array.isArray(frame.workspaces) ||
    frame.workspaces.length > 256 ||
    !frame.workspaces.every(isOpaqueId) ||
    (frame.managedWorkspace !== undefined &&
      (frame.managedWorkspace !== true ||
        frame.workspaces.length !== 1 ||
        frame.workspaces[0] !== MANAGED_WORKSPACE))
  )
    return null;
  return {
    type: "ready",
    version: RUNNER_WIRE_VERSION,
    workspaces: frame.workspaces,
    ...(frame.checkoutInspection === true && { checkoutInspection: true }),
    ...(frame.sharedWorktree === true && { sharedWorktree: true }),
    ...(frame.health === true && { health: true }),
    ...(frame.engineManagement === true && { engineManagement: true }),
    ...(frame.managedWorkspace === true && { managedWorkspace: true }),
  };
}

export type ChannelFrame =
  | { type: "data"; id: string; data: string }
  | { type: "close"; id: string };

export type ServiceFrame =
  | { type: "accept_health"; engineInventory?: true }
  | { type: "request"; id: string; command: Command }
  | ChannelFrame;

export type ResultFrame = {
  type: "result";
  id: string;
  value?: boolean | string;
  error?: string;
  code?: "host-gone";
};

export type RunnerFrame =
  | ReadyFrame
  | { type: "health"; sample: RunnerHealth }
  | { type: "engine_inventory"; entries: EngineInventoryEntry[] }
  | ResultFrame
  | ChannelFrame;

export type Frame = ServiceFrame | RunnerFrame;

/** A full branch name, never a revision expression, option, or raw ref. */
export function validBranch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    !value.startsWith("-") &&
    !value.startsWith("refs/") &&
    !value.endsWith(".") &&
    value !== "HEAD" &&
    value !== "@" &&
    !/[\x00-\x20\x7f~^:?*\[\\]|\.\.|@\{/.test(value) &&
    value
      .split("/")
      .every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"))
  );
}

/** Check the URL before a runner makes any workspace changes. */
export function parseRunnerRepositoryUrl(
  source: unknown,
  fromOrigin = false
): URL | null {
  if (
    typeof source !== "string" ||
    !source.startsWith("https://") ||
    source.length > 2048 ||
    /[\s\\?#\x00-\x1f\x7f]/.test(source)
  )
    return null;
  try {
    const url = new URL(source);
    return url.hostname &&
      url.pathname !== "/" &&
      !url.hash &&
      !url.search &&
      (fromOrigin || (!url.username && !url.password))
      ? url
      : null;
  } catch {
    return null;
  }
}

function isRepository(value: unknown): value is RunnerRepository {
  if (
    !isRecord(value) ||
    !parseRunnerRepositoryUrl(value.url) ||
    !isRecord(value.checkout)
  )
    return false;
  const checkout = value.checkout;
  if (!validBranch(checkout.branch)) return false;
  switch (checkout.kind) {
    case "new":
      return checkout.base === undefined || validBranch(checkout.base);
    case "branch":
      return true;
    case "pr":
      return (
        typeof checkout.number === "number" &&
        Number.isSafeInteger(checkout.number) &&
        checkout.number > 0
      );
    default:
      return false;
  }
}

function isServiceMcp(value: unknown): value is ServiceMcp {
  return (
    isRecord(value) &&
    isHttpUrl(value.url) &&
    typeof value.token === "string" &&
    value.token.length > 0 &&
    (value.name === undefined || typeof value.name === "string")
  );
}

function isRemoteLaunch(value: unknown): value is RemoteLaunch {
  return (
    isRecord(value) &&
    isOpaqueId(value.agentId) &&
    isRunnerEngine(value.engine) &&
    isNullableString(value.model) &&
    isNullableString(value.systemPrompt) &&
    isNullableString(value.resumeSessionId) &&
    (value.fullAccess === undefined || typeof value.fullAccess === "boolean") &&
    (value.effort === undefined || isNullableString(value.effort)) &&
    (value.personaContext === undefined ||
      isNullableString(value.personaContext)) &&
    (value.mcp === undefined || isServiceMcp(value.mcp)) &&
    (value.useWorktreeOf === undefined ||
      (isOpaqueId(value.useWorktreeOf) &&
        value.repository === undefined &&
        value.useWorktreeOf !== value.agentId)) &&
    (value.repository === undefined || isRepository(value.repository))
  );
}

function isCommand(value: unknown): value is Command {
  if (
    !isRecord(value) ||
    !isOpaqueId(value.agentId) ||
    !isOpaqueId(value.workspace)
  )
    return false;
  switch (value.kind) {
    case "launch":
      return isRemoteLaunch(value.launch);
    case "inspectCheckout":
      return isCheckoutQuery(value.query);
    case "attach":
    case "alive":
    case "discard":
    case "log":
    case "repo":
      return true;
    case "stop":
      return typeof value.force === "boolean";
    case "engine":
      return isEngineOperation(value.operation);
    default:
      return false;
  }
}

/** Correlation ID usable even if the rest of the request is malformed. */
export function runnerRequestId(value: unknown): string | undefined {
  return isRecord(value) && value.type === "request" && isOpaqueId(value.id)
    ? value.id
    : undefined;
}

function isBase64(value: unknown): value is string {
  if (typeof value !== "string" || /[^A-Za-z0-9+/=]/u.test(value)) return false;
  const paddingStart = value.indexOf("=");
  if (paddingStart === -1) return value.length % 4 !== 1;
  return (
    value.length % 4 === 0 &&
    (value.slice(paddingStart) === "=" || value.slice(paddingStart) === "==")
  );
}

function isServiceFrame(value: unknown): value is ServiceFrame {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "accept_health":
      return (
        value.engineInventory === undefined || value.engineInventory === true
      );
    case "request":
      return isOpaqueId(value.id) && isCommand(value.command);
    case "close":
      return isOpaqueId(value.id);
    case "data":
      return isOpaqueId(value.id) && isBase64(value.data);
    default:
      return false;
  }
}

/** Validate known v1 fields while preserving any additive fields from peers. */
export function parseServiceFrame(value: unknown): ServiceFrame | null {
  return isServiceFrame(value) ? value : null;
}
