import { isCheckoutQuery } from "./checkout.js";
import { isRecord } from "./validation.js";

export const MAX_CHECKOUT_COMMAND_FILE_BYTES = 256 * 1024;
export const MAX_CHECKOUT_COMMAND_REPLY_BYTES = 4 * 1024 * 1024;

export type CheckoutCommand = {
  checkout: "effective" | "launch" | "moved";
  path: string;
} & (
  | { kind: "read" }
  | {
      kind: "run";
      state: string;
      argv: string[];
    }
);

export type CheckoutExecution = {
  timeoutMs: number | null;
  maxOutput: number | null;
  shell: "direct" | "login";
  env: Record<string, string>;
};

export function isCheckoutExecutionOptions(
  value: unknown
): value is CheckoutExecution {
  const limit = (n: unknown) =>
    n === null || (typeof n === "number" && Number.isSafeInteger(n) && n >= 0);
  return (
    isRecord(value) &&
    limit(value.timeoutMs) &&
    limit(value.maxOutput) &&
    (value.shell === "direct" || value.shell === "login") &&
    isRecord(value.env) &&
    Object.entries(value.env).every(
      ([key, entry]) =>
        key.length > 0 &&
        !/[=\0]/.test(key) &&
        typeof entry === "string" &&
        !entry.includes("\0")
    )
  );
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

export function isCheckoutCommandArgv(argv: unknown): argv is string[] {
  return (
    Array.isArray(argv) &&
    argv.length > 0 &&
    argv.length <= 256 &&
    Boolean(argv[0]) &&
    argv.every(
      (arg) =>
        typeof arg === "string" && !arg.includes("\0") && fits(arg, 16 * 1024)
    ) &&
    fits(JSON.stringify(argv), 64 * 1024)
  );
}

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
    isCheckoutCommandArgv(value.argv)
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

export function isCheckoutCommandStatus(
  value: unknown
): value is Pick<CheckoutCommandResult, "exitCode" | "truncated"> &
  Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.exitCode === "number" &&
    Number.isInteger(value.exitCode) &&
    value.exitCode >= 0 &&
    value.exitCode <= 255 &&
    (value.truncated === undefined || typeof value.truncated === "boolean")
  );
}

/** Node timers clamp values outside the signed 32-bit range to one ms. */
export function scheduleDeadline(ms: number, expired: () => void) {
  const deadline = performance.now() + ms;
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) expired();
    else
      timer = setTimeout(tick, Math.min(Math.ceil(remaining), 2_147_483_647));
  };
  timer = setTimeout(tick, Math.min(ms, 2_147_483_647));
  return () => clearTimeout(timer);
}
