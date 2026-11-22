import { isOpaqueId } from "./placement.js";
import { isRecord } from "./validation.js";

/** Operations are relative to the bound session checkout. Paths never name host files. */
export type CheckoutQuery =
  | { kind: "changes"; baseBranch: string | null }
  | { kind: "readFile" | "listFiles"; path: string }
  | { kind: "roots" }
  | {
      kind: "defaultBranchFiles";
      directories: string[];
      waitForRefresh: boolean;
    };

export type CheckoutReply =
  | {
      kind: "changes";
      baseRef: string;
      head: string;
      stateId: string;
      files: string[];
    }
  | { kind: "readFile"; content: string | null }
  | { kind: "listFiles"; names: string[] }
  | {
      kind: "roots";
      checkoutRoot: string | null;
      repositoryRoot: string | null;
    }
  | DefaultBranchFilesReply;

export const DEFAULT_BRANCH_FILE_LIMIT = 100;
export const DEFAULT_BRANCH_REPLY_BYTES = 4 * 1024 * 1024;

export type DefaultBranchFilesReply = {
  kind: "defaultBranchFiles";
  hasOrigin: boolean;
  files: { path: string; content: string }[];
  warnings: string[];
  refreshing: boolean;
  updatedAt: number | null;
  truncated: boolean;
};

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

function relativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 4096 &&
    !value.includes("\0") &&
    !value.split("/").some((part) => !part || part === "." || part === "..")
  );
}

function safeCheckoutPath(value: unknown): value is string {
  return (
    relativePath(value) &&
    !value.includes("\\") &&
    !/^[a-z]:/i.test(value) &&
    !value.split("/").some((part) => part.toLowerCase() === ".git")
  );
}

export function isCheckoutQuery(value: unknown): value is CheckoutQuery {
  if (!isRecord(value)) return false;
  if (value.kind === "roots") return true;
  if (value.kind === "defaultBranchFiles") {
    return (
      Array.isArray(value.directories) &&
      value.directories.length > 0 &&
      value.directories.length <= 8 &&
      new Set(value.directories).size === value.directories.length &&
      value.directories.every(
        (dir) => safeCheckoutPath(dir) && dir.length <= 512
      ) &&
      typeof value.waitForRefresh === "boolean"
    );
  }
  if (value.kind === "readFile" || value.kind === "listFiles")
    return relativePath(value.path);
  return (
    value.kind === "changes" &&
    (value.baseBranch === null || validBranch(value.baseBranch))
  );
}

export function isCheckoutReply(
  value: unknown,
  query: CheckoutQuery
): value is CheckoutReply {
  if (!isRecord(value) || value.kind !== query.kind) return false;
  if (value.kind === "defaultBranchFiles" && query.kind === value.kind) {
    return (
      typeof value.hasOrigin === "boolean" &&
      typeof value.refreshing === "boolean" &&
      typeof value.truncated === "boolean" &&
      (value.updatedAt === null ||
        (typeof value.updatedAt === "number" &&
          Number.isFinite(value.updatedAt) &&
          value.updatedAt >= 0)) &&
      Array.isArray(value.warnings) &&
      value.warnings.length <= 8 &&
      value.warnings.every(
        (warning) => typeof warning === "string" && warning.length <= 512
      ) &&
      Array.isArray(value.files) &&
      value.files.length <= DEFAULT_BRANCH_FILE_LIMIT &&
      value.files.every(
        (file) =>
          isRecord(file) &&
          safeCheckoutPath(file.path) &&
          query.directories.includes(
            file.path.slice(0, file.path.lastIndexOf("/"))
          ) &&
          typeof file.content === "string" &&
          new TextEncoder().encode(file.content).length <= 256 * 1024
      ) &&
      new TextEncoder().encode(JSON.stringify(value)).length <=
        DEFAULT_BRANCH_REPLY_BYTES
    );
  }
  if (value.kind === "readFile")
    return (
      value.content === null ||
      (typeof value.content === "string" &&
        new TextEncoder().encode(value.content).length <= 256 * 1024)
    );
  if (value.kind === "roots")
    return (
      (value.checkoutRoot === null || isCheckoutPath(value.checkoutRoot)) &&
      (value.repositoryRoot === null || isCheckoutPath(value.repositoryRoot))
    );
  if (value.kind === "listFiles")
    return (
      Array.isArray(value.names) &&
      value.names.length <= 1024 &&
      value.names.every((name) => relativePath(name) && !/[\\/]/.test(name))
    );
  return (
    typeof value.baseRef === "string" &&
    value.baseRef.length > 0 &&
    value.baseRef.length <= 512 &&
    typeof value.stateId === "string" &&
    /^[a-f0-9]{64}$/.test(value.stateId) &&
    typeof value.head === "string" &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.head) &&
    Array.isArray(value.files) &&
    value.files.every(relativePath)
  );
}

/** A machine-local absolute directory, interpreted only by the bound runner. */
export function isCheckoutPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    value.length <= 4096 &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

export type SessionCheckout = {
  path: string;
  moved: boolean;
  origin: string | null;
  /** Common repository root; null or absent outside Git or from older runners. */
  repositoryRoot?: string | null;
  /** Git checkout root, which can differ from the selected directory. */
  checkoutRoot?: string | null;
  /** Checked-out branch, or the short commit when HEAD is detached. */
  branch?: string | null;
};

/** Observe the bound checkout, or finalize the session with a conditional removal. */
export type CheckoutRelease =
  | { kind: "observe" }
  | { kind: "release"; expectedState: string | null };

export type CheckoutObservation = {
  ownership: "owned" | "borrowed" | "external" | "none";
  /** Opaque machine-local checkout owner and dependent session handles. */
  owner: string | null;
  borrowers: string[];
  checkout: CheckoutState | null;
};

export type CheckoutState = {
  path: string;
  branch: string | null;
  stateId: string;
  unmerged: boolean;
  changedFiles: string[];
  uncommittedFiles: string[];
};

export type CheckoutReleaseResult = "released" | "retained" | "inUse";

export function isCheckoutStateId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function isCheckoutRelease(value: unknown): value is CheckoutRelease {
  return (
    isRecord(value) &&
    (value.kind === "observe" ||
      (value.kind === "release" &&
        (value.expectedState === null ||
          isCheckoutStateId(value.expectedState))))
  );
}

export function isCheckoutObservation(
  value: unknown
): value is CheckoutObservation {
  return (
    isRecord(value) &&
    (value.ownership === "owned" ||
      value.ownership === "borrowed" ||
      value.ownership === "external" ||
      value.ownership === "none") &&
    (value.ownership === "owned" || value.ownership === "borrowed"
      ? isOpaqueId(value.owner)
      : value.owner === null) &&
    Array.isArray(value.borrowers) &&
    value.borrowers.every(isOpaqueId) &&
    (value.checkout === null ||
      (isRecord(value.checkout) &&
        isCheckoutPath(value.checkout.path) &&
        (value.checkout.branch === null ||
          typeof value.checkout.branch === "string") &&
        isCheckoutStateId(value.checkout.stateId) &&
        typeof value.checkout.unmerged === "boolean" &&
        [value.checkout.changedFiles, value.checkout.uncommittedFiles].every(
          (files) =>
            Array.isArray(files) &&
            files.every((file) => typeof file === "string")
        )))
  );
}
