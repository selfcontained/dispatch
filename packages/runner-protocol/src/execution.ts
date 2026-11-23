import { isCheckoutCommand, type CheckoutCommand } from "./checkout-command.js";
import {
  isSessionFileOperation,
  type SessionFileOperation,
} from "./session-files.js";
import { isCheckoutView, type CheckoutView } from "./checkout-view.js";
import {
  isCheckoutQuery,
  isCheckoutRelease,
  type CheckoutRelease,
  isCheckoutPath,
  validBranch,
  type CheckoutQuery,
  type SessionCheckout,
} from "./checkout.js";
import { MANAGED_WORKSPACE, isOpaqueId } from "./placement.js";
import {
  type EngineInventoryEntry,
  type EngineOperation,
  isEngineOperation,
  isRunnerEngine,
} from "./engine-management.js";
import { isGitHubOperation, type GitHubOperation } from "./github.js";
import type { RunnerHealth } from "./health.js";
import {
  isUpdateAttemptId,
  parseSelfUpdateAdvert,
  parseUpdateServiceFrame,
  UPDATE_SERVICE_FRAME_TYPES,
  type SelfUpdateAdvert,
  type UpdateServiceFrame,
  type UpdateStatusFrame,
} from "./update.js";
import {
  isBase64,
  isHttpUrl,
  isNullableString,
  isRecord,
} from "./validation.js";

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
  | { kind: "branch"; branch: string; allowDefault?: true }
  | { kind: "default" }
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
  /** Opt in to workspace preparation and request-scoped progress. */
  prepareWorkspace?: true;
  /**
   * Durable identity of this launch attempt, chosen by Dispatch. A runner
   * that advertises `launchReconcile` saves it before any process starts and
   * answers a repeat of the same ID from that record. Older runners ignore it.
   */
  launchId?: string;
};

export type SessionLifecycleOperation = { agentId: string } & (
  | { kind: "launch"; launch: RemoteLaunch }
  | { kind: "attach" | "alive" | "discard" | "log" }
  | { kind: "stop"; force: boolean }
);

export type SessionOperation =
  | SessionLifecycleOperation
  | { agentId: string; kind: "sessionFile"; operation: SessionFileOperation }
  | { agentId: string; kind: "watchCheckout" }
  | { agentId: string; kind: "openTerminal" }
  | { agentId: string; kind: "viewCheckout"; query: CheckoutView }
  | { agentId: string; kind: "inspectCheckout"; query: CheckoutQuery }
  | {
      agentId: string;
      kind: "sessionCheckout";
      operation: { kind: "describe" } | { kind: "select"; path: string | null };
    }
  | { agentId: string; kind: "checkoutCommand"; operation: CheckoutCommand }
  | { agentId: string; kind: "checkoutRelease"; operation: CheckoutRelease }
  | { agentId: string; kind: "repo" };

export type RunnerOperation =
  | { kind: "engine"; operation: EngineOperation }
  | { kind: "github"; operation: GitHubOperation };

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
  streamCredit?: true;
  managedWorkspace?: true;
  /** Advertises support for the `"engine"` command and inventory push. */
  engineManagement?: true;
  engineCapabilities?: true;
  githubManagement?: true;
  repositoryPicker?: true;
  pullRequestStatus?: true;
  pullRequestWatch?: true;
  pullRequestEvidence?: true;
  checkoutInspection?: true;
  checkoutMetadata?: true;
  checkoutCommands?: true;
  terminals?: true;
  defaultBranchFiles?: true;
  checkoutViews?: true;
  sharedWorktree?: true;
  workspacePreparation?: true;
  sessionCheckout?: true;
  checkoutRelease?: true;
  sessionFiles?: true;
  filesGetStream?: true;
  /** `sessionFile` deliveries may carry their bytes on a stream. */
  filesPutStream?: true;
  /** A repeated `launch.launchId` is reconciled rather than run again. */
  launchReconcile?: true;
  /** Supervisor self-update support and the installed identity. */
  selfUpdate?: SelfUpdateAdvert;
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
  const selfUpdate =
    frame.selfUpdate === undefined
      ? null
      : parseSelfUpdateAdvert(frame.selfUpdate);
  return {
    type: "ready",
    version: RUNNER_WIRE_VERSION,
    workspaces: frame.workspaces,
    ...(frame.checkoutViews === true && { checkoutViews: true }),
    ...(frame.defaultBranchFiles === true && { defaultBranchFiles: true }),
    ...(frame.checkoutCommands === true && { checkoutCommands: true }),
    ...(frame.terminals === true && { terminals: true }),
    ...(frame.checkoutMetadata === true && { checkoutMetadata: true }),
    ...(frame.checkoutInspection === true && { checkoutInspection: true }),
    ...(frame.sharedWorktree === true && { sharedWorktree: true }),
    ...(frame.sessionFiles === true && { sessionFiles: true }),
    ...(frame.filesGetStream === true && { filesGetStream: true }),
    ...(frame.filesPutStream === true && { filesPutStream: true }),
    ...(frame.launchReconcile === true && { launchReconcile: true }),
    ...(frame.checkoutRelease === true && { checkoutRelease: true }),
    ...(frame.sessionCheckout === true && { sessionCheckout: true }),
    ...(frame.workspacePreparation === true && { workspacePreparation: true }),
    ...(frame.streamCredit === true && { streamCredit: true }),
    ...(frame.health === true && { health: true }),
    ...(frame.engineManagement === true && { engineManagement: true }),
    ...(frame.engineCapabilities === true && { engineCapabilities: true }),
    ...(frame.pullRequestEvidence === true && { pullRequestEvidence: true }),
    ...(frame.pullRequestWatch === true && { pullRequestWatch: true }),
    ...(frame.pullRequestStatus === true && { pullRequestStatus: true }),
    ...(frame.repositoryPicker === true && { repositoryPicker: true }),
    ...(frame.githubManagement === true && { githubManagement: true }),
    ...(frame.managedWorkspace === true && { managedWorkspace: true }),
    ...(selfUpdate && { selfUpdate }),
  };
}

export type ChannelFrame =
  | { type: "data"; id: string; data: string }
  | { type: "close"; id: string };

export type ServiceFrame =
  | { type: "accept_health"; engineInventory?: true }
  | { type: "request"; id: string; command: Command }
  | { type: "cancel_checkout_command"; id: string }
  | UpdateServiceFrame
  | ChannelFrame;

export type ResultFrame = {
  type: "result";
  id: string;
  value?: boolean | string;
  error?: string;
  /** `update-fenced`: refused by the update fence; it never started. */
  code?: "host-gone" | "update-fenced";
};

export type LaunchProgress =
  | { phase: "workspace" | "dependencies" | "ready" }
  | { phase: "dependencies"; status: "done" | "failed" };

export type LaunchProgressFrame = {
  type: "launch_progress";
  id: string;
  progress: LaunchProgress;
};

export function parseLaunchProgress(
  value: unknown
): LaunchProgressFrame | null {
  if (
    !isRecord(value) ||
    value.type !== "launch_progress" ||
    !isOpaqueId(value.id) ||
    !isRecord(value.progress)
  )
    return null;
  const { phase, status } = value.progress;
  if (phase === "dependencies" && (status === "done" || status === "failed"))
    return { type: value.type, id: value.id, progress: { phase, status } };
  if (
    status === undefined &&
    (phase === "workspace" || phase === "dependencies" || phase === "ready")
  )
    return { type: value.type, id: value.id, progress: { phase } };
  return null;
}

export type RunnerFrame =
  | ReadyFrame
  | { type: "health"; sample: RunnerHealth }
  | { type: "engine_inventory"; entries: EngineInventoryEntry[] }
  | ResultFrame
  | LaunchProgressFrame
  | UpdateStatusFrame
  | ChannelFrame;

export type Frame = ServiceFrame | RunnerFrame;

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

export function isSessionCheckout(value: unknown): value is SessionCheckout {
  return (
    isRecord(value) &&
    isCheckoutPath(value.path) &&
    typeof value.moved === "boolean" &&
    (value.origin === null ||
      parseRunnerRepositoryUrl(value.origin) !== null) &&
    (value.repositoryRoot === undefined ||
      value.repositoryRoot === null ||
      isCheckoutPath(value.repositoryRoot)) &&
    (value.checkoutRoot === undefined ||
      value.checkoutRoot === null ||
      isCheckoutPath(value.checkoutRoot)) &&
    (value.branch === undefined ||
      value.branch === null ||
      (typeof value.branch === "string" &&
        value.branch.length > 0 &&
        value.branch.length <= 255 &&
        !/[\0-\x1f\x7f]/.test(value.branch)))
  );
}

function isRepository(value: unknown): value is RunnerRepository {
  if (
    !isRecord(value) ||
    !parseRunnerRepositoryUrl(value.url) ||
    !isRecord(value.checkout)
  )
    return false;
  const checkout = value.checkout;
  if (checkout.kind === "default") return checkout.branch === undefined;
  if (!validBranch(checkout.branch)) return false;
  switch (checkout.kind) {
    case "new":
      return checkout.base === undefined || validBranch(checkout.base);
    case "branch":
      return (
        checkout.allowDefault === undefined || checkout.allowDefault === true
      );
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
    (value.prepareWorkspace === undefined || value.prepareWorkspace === true) &&
    (value.launchId === undefined || isUpdateAttemptId(value.launchId)) &&
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
      return (
        isRemoteLaunch(value.launch) &&
        (value.launch.useWorktreeOf === undefined ||
          value.agentId === value.launch.agentId)
      );
    case "sessionFile":
      return isSessionFileOperation(value.operation);
    case "checkoutCommand":
      return isCheckoutCommand(value.operation);
    case "checkoutRelease":
      return isCheckoutRelease(value.operation);
    case "sessionCheckout":
      return (
        isRecord(value.operation) &&
        (value.operation.kind === "describe" ||
          (value.operation.kind === "select" &&
            (value.operation.path === null ||
              isCheckoutPath(value.operation.path))))
      );
    case "openTerminal":
    case "watchCheckout":
      return true;
    case "viewCheckout":
      return isCheckoutView(value.query);
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
    case "github":
      return isGitHubOperation(value.operation);
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

function isServiceFrame(value: unknown): value is ServiceFrame {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "accept_health":
      return (
        value.engineInventory === undefined || value.engineInventory === true
      );
    case "request":
      return isOpaqueId(value.id) && isCommand(value.command);
    case "cancel_checkout_command":
    case "close":
      return isOpaqueId(value.id);
    case "data":
      return isOpaqueId(value.id) && isBase64(value.data);
    default:
      return false;
  }
}

/** Validate known v1 fields while preserving any additive fields from peers.
 * Update frames are rebuilt from their known fields. */
export function parseServiceFrame(value: unknown): ServiceFrame | null {
  if (isRecord(value) && UPDATE_SERVICE_FRAME_TYPES.has(value.type as string))
    return parseUpdateServiceFrame(value);
  return isServiceFrame(value) ? value : null;
}
