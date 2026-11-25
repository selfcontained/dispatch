import {
  isCheckoutReadStream,
  type CheckoutReadRequest,
} from "./checkout-reads.js";
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

/** Inline first-text budget; larger launches use a private file. */
export const MAX_INLINE_FIRST_TEXT_BYTES = 64 * 1024;

import { isTerminalControl } from "./terminal.js";

import { operations, type Req } from "./contract/index.js";

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
  /** Controller that owns this launch, sent to peers with sessionObservation. */
  owner?: string;
};

export type SessionLifecycleOperation = { agentId: string } & (
  | { kind: "launch"; launch: RemoteLaunch }
  | { kind: "attach" | "alive" | "discard" | "log" }
  | {
      kind: "stop";
      force: boolean;
      expectedLaunchId?: string;
      expectedOwner?: string;
    }
);

export type GitQueryName =
  | "git.defaultBranch"
  | "git.branches"
  | "git.base"
  | "git.origin";
export type GitQuery = {
  [K in GitQueryName]: { op: K; request: Req<K> };
}[GitQueryName];

export type SessionOperation =
  | SessionLifecycleOperation
  | { agentId: string; kind: "gitQuery"; operation: GitQuery }
  /** `checkout.write` in the session's checkout, served with `checkoutWrite`. */
  | {
      agentId: string;
      kind: "checkoutWrite";
      operation: { op: "checkout.write"; request: Req<"checkout.write"> };
    }
  /**
   * `checkout.defaultFiles` for a `{repository}` target, read from the
   * runner's repository cache; served with `repositoryFiles`.
   */
  | {
      agentId: string;
      kind: "repositoryFiles";
      operation: {
        op: "checkout.defaultFiles";
        request: Req<"checkout.defaultFiles">;
      };
    }
  /**
   * `path.resolve` as the workload account (`~` is its HOME); served with
   * `pathResolve`.
   */
  | {
      agentId: string;
      kind: "pathResolve";
      operation: { op: "path.resolve"; request: Req<"path.resolve"> };
    }
  | { agentId: string; kind: "sessionFile"; operation: SessionFileOperation }
  | { agentId: string; kind: "watchCheckout" }
  | {
      agentId: string;
      kind: "openTerminal";
      stream?: { input: string; output: string; cols: number; rows: number };
    }
  | {
      agentId: string;
      kind: "checkoutRead";
      operation: CheckoutReadRequest & { streamId: string };
    }
  | { agentId: string; kind: "viewCheckout"; query: CheckoutView }
  | { agentId: string; kind: "inspectCheckout"; query: CheckoutQuery }
  | {
      agentId: string;
      kind: "sessionCheckout";
      operation:
        | { kind: "describe" }
        | { kind: "select"; path: string | null }
        | { kind: "context"; checkout?: "current" | "launch" | "moved" };
    }
  | {
      agentId: string;
      kind: "workspacePrepare";
      operation: Omit<Req<"workspace.prepare">, "session">;
    }
  | { agentId: string; kind: "workspaceResume" }
  | {
      agentId: string;
      kind: "workspaceRelease";
      operation: Omit<Req<"workspace.release">, "session">;
    }
  | { agentId: string; kind: "checkoutCommand"; operation: CheckoutCommand }
  | { agentId: string; kind: "checkoutRelease"; operation: CheckoutRelease }
  | { agentId: string; kind: "repo" };

export type SessionObservation = {
  [K in "session.list" | "session.sample"]: { op: K; request: Req<K> };
}["session.list" | "session.sample"];

export type RunnerOperation =
  | { kind: "engine"; operation: EngineOperation }
  | { kind: "github"; operation: GitHubOperation };

/** V1 uses one envelope for both scopes. Runner operations ignore the agent id. */
export type Command = { workspace: string } & (
  | SessionOperation
  | (RunnerOperation & { agentId: string })
  | {
      kind: "sessionObservation";
      operation: SessionObservation;
      agentId: string;
    }
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
  checkoutExecStream?: true;
  checkoutReadStream?: true;
  terminals?: true;
  terminalOpenStream?: true;
  defaultBranchFiles?: true;
  checkoutViews?: true;
  sharedWorktree?: true;
  workspacePreparation?: true;
  workspacePrepare?: true;
  /** A launch starts directly from a workspace preparation receipt. */
  preparedLaunch?: true;
  /** Workspace preparation can use another session's current folder. */
  sessionWorkspaceSource?: true;
  gitQueries?: true;
  /** This v1 peer writes in a session's checkout as its workload (`checkoutWrite`). */
  checkoutWrite?: true;
  /** This v1 peer reads a repository's default-branch files from its cache (`repositoryFiles`). */
  repositoryFiles?: true;
  /** This v1 peer resolves a folder as its workload account (`pathResolve`). */
  pathResolve?: true;
  /** This v1 peer serves session inventory and process samples. */
  sessionObservation?: true;
  workspaceRelease?: true;
  sessionCheckout?: true;
  checkoutRelease?: true;
  sessionFiles?: true;
  filesGetStream?: true;
  /** `sessionFile` deliveries may carry their bytes on a stream. */
  filesPutStream?: true;
  /** A repeated `launch.launchId` is reconciled rather than run again. */
  launchReconcile?: true;
  /** Stop can compare the expected launch ID while holding the session lock. */
  scopedStop?: true;
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
    ...(frame.preparedLaunch === true && { preparedLaunch: true }),
    ...(frame.sessionObservation === true && { sessionObservation: true }),
    ...(frame.sessionWorkspaceSource === true && {
      sessionWorkspaceSource: true,
    }),
    ...(frame.gitQueries === true && { gitQueries: true }),
    ...(frame.checkoutWrite === true && { checkoutWrite: true }),
    ...(frame.repositoryFiles === true && { repositoryFiles: true }),
    ...(frame.pathResolve === true && { pathResolve: true }),
    ...(frame.workspacePrepare === true && { workspacePrepare: true }),
    ...(frame.workspaceRelease === true && { workspaceRelease: true }),
    ...(frame.checkoutViews === true && { checkoutViews: true }),
    ...(frame.defaultBranchFiles === true && { defaultBranchFiles: true }),
    ...(frame.checkoutCommands === true && { checkoutCommands: true }),
    ...(frame.checkoutReadStream === true && { checkoutReadStream: true }),
    ...(frame.checkoutExecStream === true && { checkoutExecStream: true }),
    ...(frame.terminals === true && { terminals: true }),
    ...(frame.terminalOpenStream === true && { terminalOpenStream: true }),
    ...(frame.checkoutMetadata === true && { checkoutMetadata: true }),
    ...(frame.checkoutInspection === true && { checkoutInspection: true }),
    ...(frame.sharedWorktree === true && { sharedWorktree: true }),
    ...(frame.sessionFiles === true && { sessionFiles: true }),
    ...(frame.filesGetStream === true && { filesGetStream: true }),
    ...(frame.filesPutStream === true && { filesPutStream: true }),
    ...(frame.launchReconcile === true && { launchReconcile: true }),
    ...(frame.scopedStop === true && { scopedStop: true }),
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
  code?: "host-gone" | "update-fenced" | "stale" | "timeout";
};

export type LaunchProgress =
  | { phase: "workspace" | "copy" | "dependencies" | "ready" }
  | { phase: "dependencies"; status: "done" | "failed"; detail?: string };

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
  const { phase, status, detail } = value.progress;
  if (phase === "dependencies" && (status === "done" || status === "failed"))
    return {
      type: value.type,
      id: value.id,
      progress: {
        phase,
        status,
        ...(typeof detail === "string" && { detail }),
      },
    };
  if (
    status === undefined &&
    (phase === "workspace" ||
      phase === "copy" ||
      phase === "dependencies" ||
      phase === "ready")
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

export function repositoryUrl(input: string, fromOrigin = false): string {
  let source = input;
  if (fromOrigin) {
    const ssh = /^(?:git@|ssh:\/\/git@)([\w.-]+)[:/]([\w./-]+)$/.exec(input);
    if (ssh) source = `https://${ssh[1]}/${ssh[2]}`;
  }
  const invalid = () =>
    new Error("Runner repositories require a credential-free HTTPS Git URL.");
  const url = parseRunnerRepositoryUrl(source, fromOrigin);
  if (!url) throw invalid();
  url.username = "";
  url.password = "";
  return url.href;
}

/** A project identifies the repository independently of the clone URL spelling. */
export function projectRepositoryUrl(
  input: string,
  fromOrigin = false
): string {
  const url = new URL(repositoryUrl(input, fromOrigin));
  url.pathname = url.pathname
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  return url.href;
}

export type RepositoryInput = { url?: string; checkout: RepositoryCheckout };
/**
 * A launch's repository: a raw checkout plan (older clients), or only the
 * origin, whose checkout comes from the launch's worktree intent.
 */
export type RepositoryTarget = { url?: string; checkout?: RepositoryCheckout };

export function parseRepositoryTarget(input: unknown): RepositoryTarget {
  if (input && typeof input === "object" && !("checkout" in input)) {
    if (!("url" in input) || input.url === undefined) return {};
    if (typeof input.url !== "string")
      throw new Error("Repository URL must be a string.");
    return { url: repositoryUrl(input.url) };
  }
  return parseRepository(input);
}

export function parseRepository(input: unknown): RepositoryInput {
  if (!input || typeof input !== "object" || !("checkout" in input))
    throw new Error("A runner repository requires a checkout.");
  let url: string | undefined;
  if ("url" in input && input.url !== undefined) {
    if (typeof input.url !== "string")
      throw new Error("Repository URL must be a string.");
    url = repositoryUrl(input.url);
  }
  const checkout = input.checkout;
  if (!checkout || typeof checkout !== "object" || !("kind" in checkout))
    throw new Error("A valid checkout branch is required.");
  if (checkout.kind === "default") {
    if ("branch" in checkout && checkout.branch !== undefined)
      throw new Error("A default checkout resolves its branch on the runner.");
    return { url, checkout: { kind: "default" } };
  }
  if (!("branch" in checkout) || !validBranch(checkout.branch))
    throw new Error("A valid checkout branch is required.");
  const { branch } = checkout;
  switch (checkout.kind) {
    case "new": {
      const base = "base" in checkout ? checkout.base : undefined;
      if (base !== undefined && !validBranch(base))
        throw new Error("The checkout base must be a valid branch name.");
      return { url, checkout: { kind: "new", branch, base } };
    }
    case "branch": {
      const allowDefault =
        "allowDefault" in checkout ? checkout.allowDefault : undefined;
      if (allowDefault !== undefined && allowDefault !== true)
        throw new Error("allowDefault must be true when provided.");
      return {
        url,
        checkout: {
          kind: "branch",
          branch,
          ...(allowDefault && { allowDefault }),
        },
      };
    }
    case "pr": {
      const number = "number" in checkout ? checkout.number : undefined;
      if (
        typeof number !== "number" ||
        !Number.isSafeInteger(number) ||
        number < 1
      )
        throw new Error("The pull request number must be a positive integer.");
      return { url, checkout: { kind: "pr", branch, number } };
    }
    default:
      throw new Error("Checkout kind must be new, branch, default, or pr.");
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
    (value.owner === undefined || isOpaqueId(value.owner)) &&
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
    case "sessionObservation": {
      const op = value.operation;
      return (
        isRecord(op) &&
        (op.op === "session.list" || op.op === "session.sample") &&
        operations[op.op].request.check(op.request)
      );
    }
    case "checkoutWrite": {
      const op = value.operation;
      return (
        isRecord(op) &&
        op.op === "checkout.write" &&
        operations["checkout.write"].request.check(op.request) &&
        "session" in op.request.target
      );
    }
    case "repositoryFiles": {
      const op = value.operation;
      return (
        isRecord(op) &&
        op.op === "checkout.defaultFiles" &&
        operations["checkout.defaultFiles"].request.check(op.request) &&
        "repository" in op.request.target
      );
    }
    case "pathResolve": {
      const op = value.operation;
      return (
        isRecord(op) &&
        op.op === "path.resolve" &&
        operations["path.resolve"].request.check(op.request)
      );
    }
    case "gitQuery": {
      const op = value.operation;
      return (
        isRecord(op) &&
        (op.op === "git.origin" ||
          op.op === "git.branches" ||
          op.op === "git.defaultBranch" ||
          op.op === "git.base") &&
        operations[op.op].request.check(op.request)
      );
    }
    case "workspacePrepare":
      return (
        isRecord(value.operation) &&
        operations["workspace.prepare"].request.check({
          ...value.operation,
          session: value.agentId,
        })
      );
    case "workspaceRelease":
      return (
        isRecord(value.operation) &&
        operations["workspace.release"].request.check({
          ...value.operation,
          session: value.agentId,
        })
      );
    case "workspaceResume":
      return true;
    case "sessionFile":
      return isSessionFileOperation(value.operation);
    case "checkoutRead":
      return isCheckoutReadStream(value.operation, value.agentId);
    case "checkoutCommand":
      return isCheckoutCommand(value.operation);
    case "checkoutRelease":
      return isCheckoutRelease(value.operation);
    case "sessionCheckout":
      return (
        isRecord(value.operation) &&
        (value.operation.kind === "describe" ||
          (value.operation.kind === "context" &&
            (value.operation.checkout === undefined ||
              value.operation.checkout === "current" ||
              value.operation.checkout === "launch" ||
              value.operation.checkout === "moved")) ||
          (value.operation.kind === "select" &&
            (value.operation.path === null ||
              isCheckoutPath(value.operation.path))))
      );
    case "openTerminal":
      return (
        value.stream === undefined ||
        (isRecord(value.stream) &&
          isOpaqueId(value.stream.input) &&
          isOpaqueId(value.stream.output) &&
          value.stream.input !== value.stream.output &&
          isTerminalControl({ ...value.stream, type: "resize" }))
      );
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
      return (
        typeof value.force === "boolean" &&
        (value.expectedLaunchId === undefined ||
          isUpdateAttemptId(value.expectedLaunchId)) &&
        (value.expectedOwner === undefined ||
          (isOpaqueId(value.expectedOwner) &&
            isUpdateAttemptId(value.expectedLaunchId)))
      );
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
