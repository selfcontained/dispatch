import { isOpaqueId } from "./placement.js";
import { isRecord } from "./validation.js";

/*
 * Supervisor self-update frames for wire v1. They are negotiated by
 * `ready.selfUpdate` on an approved connection: a service sends them only to
 * a runner that advertised it, and a runner sends `update_status` only in
 * reply to one of them. Peers without the capability see the old protocol.
 * The frames carry build identity and opaque session IDs only, never Dispatch
 * prompts, schedules or interruption policy.
 */

export const RUNNER_SELF_UPDATE_PROTOCOL = 1;
/** Caps the retained inventory carried in one status frame. */
export const MAX_UPDATE_RETAINED = 1024;
const MAX_HANDOFF_FORMATS = 32;

export type RunnerUpdateArch = "x64" | "arm64";

/** Artifact identity. `revision` is the full 40-character build revision. */
export type RunnerUpdateTarget = {
  version: string;
  os: "linux";
  arch: RunnerUpdateArch;
  sha256: string;
  revision: string;
};

export type RunnerInstalledBuild = {
  version: string;
  revision: string;
  sha256: string;
};

export type SelfUpdateAdvert = {
  protocol: typeof RUNNER_SELF_UPDATE_PROTOCOL;
  os: "linux";
  arch: RunnerUpdateArch;
  version: string;
  revision: string;
  installedSha256: string;
  handoff: { reads: number[]; writes: number };
  pendingAttemptId?: string;
  fenceUnreadable?: true;
};

export type RunnerUpdateReason =
  | "staging"
  | "ready"
  | "incompatible_handoff"
  | "operations_pending"
  | "fence_ready"
  | "trial"
  | "verify_failed"
  | "downgrade"
  | "boot_failed"
  | "confirm_timeout"
  | "reattach_failed"
  | "trial_interrupted"
  | "suppressed"
  | "cancelled";

export const RUNNER_UPDATE_REASONS: readonly RunnerUpdateReason[] = [
  "staging",
  "ready",
  "incompatible_handoff",
  "operations_pending",
  "fence_ready",
  "trial",
  "verify_failed",
  "downgrade",
  "boot_failed",
  "confirm_timeout",
  "reattach_failed",
  "trial_interrupted",
  "suppressed",
  "cancelled",
];

export type RunnerUpdatePhase =
  | "deferred"
  | "activating"
  | "confirmed"
  | "rolled_back";

export type RunnerUpdateCancelReason =
  | "policy_changed"
  | "quiesce_timeout"
  | "trial_failed";

export type RetainedSession = { sessionId: string; instanceId: string };

export type UpdateOfferFrame = {
  type: "update_offer";
  attemptId: string;
  target: RunnerUpdateTarget;
  retry: boolean;
};
export type UpdateFenceFrame = {
  type: "update_fence";
  attemptId: string;
  retainSessions: boolean;
};
export type UpdateActivateFrame = {
  type: "update_activate";
  attemptId: string;
};
export type UpdateConfirmFrame = {
  type: "update_confirm";
  attemptId: string;
  revision: string;
  sha256: string;
};
export type UpdateCancelFrame = {
  type: "update_cancel";
  attemptId: string;
  reason: RunnerUpdateCancelReason;
};

export type UpdateServiceFrame =
  | UpdateOfferFrame
  | UpdateFenceFrame
  | UpdateActivateFrame
  | UpdateConfirmFrame
  | UpdateCancelFrame;

export type UpdateStatusFrame = {
  type: "update_status";
  attemptId: string;
  phase: RunnerUpdatePhase;
  reason?: RunnerUpdateReason;
  /** The runner's confirmed floor. Only with reason `downgrade`. */
  floorVersion?: string;
  installed: RunnerInstalledBuild;
  /** An unreadable fence was cleared. Only with `deferred`/`cancelled`. */
  fenceCleared?: true;
  retained?: RetainedSession[];
  requiresQuiescence?: boolean;
};

/*
 * A service from before `trial_interrupted` rejects an unknown reason by
 * closing the connection, and a runner replays its terminal status on every
 * connection. So that reason travels as `cancelled` plus `interrupted: true`.
 */
export function encodeUpdateStatus(
  frame: UpdateStatusFrame
): UpdateStatusFrame & { interrupted?: true } {
  return frame.reason === "trial_interrupted"
    ? { ...frame, reason: "cancelled", interrupted: true }
    : frame;
}

export const UPDATE_SERVICE_FRAME_TYPES: ReadonlySet<string> = new Set([
  "update_offer",
  "update_fence",
  "update_activate",
  "update_confirm",
  "update_cancel",
]);

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HOST_INSTANCE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const VERSION = /^[0-9][0-9A-Za-z.+-]{0,63}$/;
const REVISION = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function isUpdateAttemptId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
const isVersion = (value: unknown): value is string =>
  typeof value === "string" && VERSION.test(value);
const isRevision = (value: unknown): value is string =>
  typeof value === "string" && REVISION.test(value);
const isSha256 = (value: unknown): value is string =>
  typeof value === "string" && SHA256.test(value);
const isArch = (value: unknown): value is RunnerUpdateArch =>
  value === "x64" || value === "arm64";
const isFormat = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value > 0 &&
  value < 0x10000;

export function parseUpdateTarget(value: unknown): RunnerUpdateTarget | null {
  if (
    !isRecord(value) ||
    !isVersion(value.version) ||
    value.os !== "linux" ||
    !isArch(value.arch) ||
    !isSha256(value.sha256) ||
    !isRevision(value.revision)
  )
    return null;
  return {
    version: value.version,
    os: "linux",
    arch: value.arch,
    sha256: value.sha256,
    revision: value.revision,
  };
}

function parseInstalled(value: unknown): RunnerInstalledBuild | null {
  if (
    !isRecord(value) ||
    !isVersion(value.version) ||
    !isRevision(value.revision) ||
    !isSha256(value.sha256)
  )
    return null;
  return {
    version: value.version,
    revision: value.revision,
    sha256: value.sha256,
  };
}

/** A malformed advertisement means no capability, never a failed handshake. */
export function parseSelfUpdateAdvert(value: unknown): SelfUpdateAdvert | null {
  if (
    !isRecord(value) ||
    value.protocol !== RUNNER_SELF_UPDATE_PROTOCOL ||
    value.os !== "linux" ||
    !isArch(value.arch) ||
    !isVersion(value.version) ||
    !isRevision(value.revision) ||
    !isSha256(value.installedSha256) ||
    !isRecord(value.handoff) ||
    !Array.isArray(value.handoff.reads) ||
    value.handoff.reads.length === 0 ||
    value.handoff.reads.length > MAX_HANDOFF_FORMATS ||
    !value.handoff.reads.every(isFormat) ||
    !isFormat(value.handoff.writes) ||
    (value.fenceUnreadable !== undefined && value.fenceUnreadable !== true) ||
    (value.pendingAttemptId !== undefined &&
      (!isUpdateAttemptId(value.pendingAttemptId) ||
        value.fenceUnreadable === true))
  )
    return null;
  return {
    protocol: RUNNER_SELF_UPDATE_PROTOCOL,
    os: "linux",
    arch: value.arch,
    version: value.version,
    revision: value.revision,
    installedSha256: value.installedSha256,
    handoff: {
      reads: [...value.handoff.reads],
      writes: value.handoff.writes,
    },
    ...(value.fenceUnreadable === true && { fenceUnreadable: true }),
    ...(value.pendingAttemptId !== undefined && {
      pendingAttemptId: value.pendingAttemptId,
    }),
  };
}

/** Service to runner. Returns a new object with only the known fields. */
export function parseUpdateServiceFrame(
  value: unknown
): UpdateServiceFrame | null {
  if (!isRecord(value) || !isUpdateAttemptId(value.attemptId)) return null;
  const { attemptId } = value;
  switch (value.type) {
    case "update_offer": {
      const target = parseUpdateTarget(value.target);
      return target && typeof value.retry === "boolean"
        ? { type: value.type, attemptId, target, retry: value.retry }
        : null;
    }
    case "update_fence":
      return typeof value.retainSessions === "boolean"
        ? { type: value.type, attemptId, retainSessions: value.retainSessions }
        : null;
    case "update_activate":
      return { type: value.type, attemptId };
    case "update_confirm":
      return isRevision(value.revision) && isSha256(value.sha256)
        ? {
            type: value.type,
            attemptId,
            revision: value.revision,
            sha256: value.sha256,
          }
        : null;
    case "update_cancel":
      return value.reason === "policy_changed" ||
        value.reason === "quiesce_timeout" ||
        value.reason === "trial_failed"
        ? { type: value.type, attemptId, reason: value.reason }
        : null;
    default:
      return null;
  }
}

/** Opaque retained session IDs and distinct host-instance IDs. */
export function parseRetainedSessions(
  value: unknown
): RetainedSession[] | null {
  if (!Array.isArray(value) || value.length > MAX_UPDATE_RETAINED) return null;
  const retained: RetainedSession[] = [];
  const instances = new Set<string>();
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !isOpaqueId(entry.sessionId) ||
      typeof entry.instanceId !== "string" ||
      !HOST_INSTANCE.test(entry.instanceId) ||
      instances.has(entry.instanceId)
    )
      return null;
    instances.add(entry.instanceId);
    retained.push({ sessionId: entry.sessionId, instanceId: entry.instanceId });
  }
  return retained;
}

/** Runner to service. Returns a new object with only the known fields. */
export function parseUpdateStatus(value: unknown): UpdateStatusFrame | null {
  if (
    !isRecord(value) ||
    value.type !== "update_status" ||
    !isUpdateAttemptId(value.attemptId) ||
    !(
      value.phase === "deferred" ||
      value.phase === "activating" ||
      value.phase === "confirmed" ||
      value.phase === "rolled_back"
    ) ||
    (value.reason !== undefined &&
      !RUNNER_UPDATE_REASONS.includes(value.reason as RunnerUpdateReason)) ||
    (value.floorVersion !== undefined &&
      (value.reason !== "downgrade" || !isVersion(value.floorVersion))) ||
    (value.fenceCleared !== undefined &&
      (value.fenceCleared !== true ||
        value.phase !== "deferred" ||
        value.reason !== "cancelled")) ||
    (value.interrupted !== undefined &&
      (value.interrupted !== true ||
        value.reason !== "cancelled" ||
        value.fenceCleared !== undefined ||
        (value.phase !== "deferred" && value.phase !== "rolled_back"))) ||
    (value.requiresQuiescence !== undefined &&
      typeof value.requiresQuiescence !== "boolean")
  )
    return null;
  const installed = parseInstalled(value.installed);
  if (!installed) return null;
  let retained: RetainedSession[] | undefined;
  if (value.retained !== undefined) {
    const parsed = parseRetainedSessions(value.retained);
    if (!parsed) return null;
    retained = parsed;
  }
  return {
    type: "update_status",
    attemptId: value.attemptId,
    phase: value.phase,
    ...(value.reason !== undefined && {
      reason: value.interrupted
        ? "trial_interrupted"
        : (value.reason as RunnerUpdateReason),
    }),
    ...(value.floorVersion !== undefined && {
      floorVersion: value.floorVersion as string,
    }),
    installed,
    ...(value.fenceCleared === true && { fenceCleared: true }),
    ...(retained && { retained }),
    ...(value.requiresQuiescence !== undefined && {
      requiresQuiescence: value.requiresQuiescence,
    }),
  };
}
