/** Undefined is reserved for trusted user/server operations, not agent calls. */
export function assertAccessCeiling(
  fullAccess: boolean,
  callerFullAccess: boolean | undefined
): void {
  if (fullAccess && callerFullAccess === false) {
    throw new Error(
      "Permission denied: a restricted agent cannot run or modify full-access jobs or templates."
    );
  }
}
