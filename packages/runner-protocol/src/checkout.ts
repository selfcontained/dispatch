import { isRecord } from "./validation.js";

/** Operations are relative to the bound session checkout. Paths never name host files. */
export type CheckoutQuery =
  | { kind: "changes"; baseBranch: string | null }
  | { kind: "readFile"; path: string };

export type CheckoutReply =
  | {
      kind: "changes";
      baseRef: string;
      head: string;
      stateId: string;
      files: string[];
    }
  | { kind: "readFile"; content: string | null };

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

export function isCheckoutQuery(value: unknown): value is CheckoutQuery {
  if (!isRecord(value)) return false;
  if (value.kind === "readFile") return relativePath(value.path);
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
  if (value.kind === "readFile")
    return value.content === null || typeof value.content === "string";
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
