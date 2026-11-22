import { isCheckoutQuery } from "./checkout.js";
import { isRecord } from "./validation.js";

const REPO_TOOL_TIMEOUT_MS = 5 * 60_000;
const LIFECYCLE_HOOK_TIMEOUT_MS = 15_000;
export const MAX_CHECKOUT_COMMAND_OUTPUT_BYTES = 64 * 1024;
export const MAX_CHECKOUT_COMMAND_FILE_BYTES = 256 * 1024;
export const MAX_CHECKOUT_COMMAND_REPLY_BYTES = 4 * 1024 * 1024;

export type CheckoutCommand = {
  checkout: "effective" | "launch" | "moved";
  path: string;
} & ({ kind: "read" } | { kind: "run"; state: string; argv: string[] });

export function checkoutCommandTimeoutMs(
  checkout: CheckoutCommand["checkout"]
): number {
  // Repo tools can start or rebuild project services before returning.
  return checkout === "effective"
    ? REPO_TOOL_TIMEOUT_MS
    : LIFECYCLE_HOOK_TIMEOUT_MS;
}

export type CheckoutCommandFile = { content: string; state: string };
export type CheckoutCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Present when the executor was given an output limit. */
  truncated?: boolean;
};

const utf8 = new TextEncoder();
const fits = (value: string, limit: number) =>
  value.length <= limit && utf8.encode(value).length <= limit;

const digest = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function isCheckoutCommand(value: unknown): value is CheckoutCommand {
  if (
    !isRecord(value) ||
    !isCheckoutQuery({
      kind: "readFile",
      path: value.path,
    }) ||
    (value.checkout !== "effective" &&
      value.checkout !== "launch" &&
      value.checkout !== "moved")
  )
    return false;
  if (value.kind === "read") return Object.keys(value).length === 3;
  return (
    value.kind === "run" &&
    Object.keys(value).length === 5 &&
    digest(value.state) &&
    Array.isArray(value.argv) &&
    value.argv.length > 0 &&
    value.argv.length <= 256 &&
    Boolean(value.argv[0]) &&
    value.argv.every(
      (arg) =>
        typeof arg === "string" && !arg.includes("\0") && fits(arg, 16 * 1024)
    ) &&
    fits(JSON.stringify(value.argv), 64 * 1024)
  );
}

export function isCheckoutCommandFile(
  value: unknown
): value is CheckoutCommandFile | null {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value.content === "string" &&
      fits(value.content, MAX_CHECKOUT_COMMAND_FILE_BYTES) &&
      digest(value.state))
  );
}

export function isCheckoutCommandResult(
  value: unknown
): value is CheckoutCommandResult {
  return (
    isRecord(value) &&
    typeof value.exitCode === "number" &&
    Number.isInteger(value.exitCode) &&
    value.exitCode >= 0 &&
    value.exitCode <= 255 &&
    [value.stdout, value.stderr].every(
      (output) =>
        typeof output === "string" &&
        fits(output, MAX_CHECKOUT_COMMAND_OUTPUT_BYTES)
    ) &&
    (value.truncated === undefined || typeof value.truncated === "boolean")
  );
}
