/**
 * Error helpers, re-exported from the shared server module so both halves of
 * the app normalize thrown values the same way (see
 * apps/server/src/shared/lib/error-message.ts).
 */
export { errorMessage } from "../../../server/src/shared/lib/error-message";

/** The HTTP status of a failed request, when the server answered. */
export function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { status } = error as { status?: unknown };
  return typeof status === "number" ? status : undefined;
}

/**
 * The second line of a failure. The server's own words go behind Details,
 * so this says what to do next.
 */
export function failureHint(error: unknown): string {
  const status = errorStatus(error);
  if (status === undefined) {
    // fetch rejects with a TypeError when the server can't be reached.
    return error instanceof TypeError
      ? "Check your connection, then try again."
      : "Try again.";
  }
  if (status >= 500) return "Try again in a moment.";
  if (status === 404) return "It may have been removed.";
  return "See Details for the reason.";
}
