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

/** The engine's approval mode does not elevate a reviewer's Dispatch tools. */
export function hasDispatchFullAccess(agent: {
  role?: string | null;
  fullAccess?: boolean;
}): boolean {
  return agent.role !== "review" && agent.fullAccess === true;
}
