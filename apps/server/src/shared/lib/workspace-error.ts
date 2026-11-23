/**
 * A checkout read's failure with the HTTP status the app answers it with.
 * Raised by the workload's views, and rebuilt by the app from a runner's
 * error details so both give the same answer.
 */
export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}
