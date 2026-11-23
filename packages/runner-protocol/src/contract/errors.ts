import {
  json,
  literal,
  object,
  optional,
  string,
  type Infer,
} from "./schema.js";

/** Every failure is `{code, message, details?}`. The caller maps codes to its own statuses and wording. */
export const ERROR_CODES = [
  "invalid",
  "not_found",
  "forbidden",
  "conflict",
  "stale",
  "busy",
  "too_large",
  "unsupported",
  "unauthenticated",
  "unavailable",
  "unknown_outcome",
  "host_gone",
  "fenced",
  "cancelled",
  "timeout",
  "failed",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Any operation may fail with these. Operation entries list only the others. */
export const COMMON_ERRORS = [
  "invalid",
  "unavailable",
  "unknown_outcome",
  "fenced",
  "cancelled",
  "timeout",
  "failed",
] as const satisfies readonly ErrorCode[];

export type CommonError = (typeof COMMON_ERRORS)[number];
export type DeclarableError = Exclude<ErrorCode, CommonError>;

/** When a caller may try again after each code. */
export const ERROR_RETRY = {
  invalid: "never",
  not_found: "never",
  forbidden: "never",
  conflict: "never",
  stale: "after-reread",
  busy: "later",
  too_large: "never",
  unsupported: "never",
  unauthenticated: "after-sign-in",
  unavailable: "yes",
  unknown_outcome: "by-operation-rule",
  host_gone: "after-relaunch",
  fenced: "when-released",
  cancelled: "by-operation-rule",
  timeout: "by-operation-rule",
  failed: "never",
} as const satisfies Record<ErrorCode, string>;

export const runnerError = object({
  code: literal(...ERROR_CODES),
  message: string,
  details: optional(json),
});

export type RunnerError = Infer<typeof runnerError>;

/** A rejected call carries the protocol error unchanged. */
export class RunnerCallError extends Error {
  readonly code: ErrorCode;
  readonly details: RunnerError["details"];
  constructor(error: RunnerError) {
    super(error.message);
    this.name = "RunnerCallError";
    this.code = error.code;
    this.details = error.details;
  }
}
