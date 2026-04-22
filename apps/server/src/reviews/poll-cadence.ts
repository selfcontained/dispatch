export const RECHECK_POLL_TIMEOUT = "cancelled" as const;

export function pollCadenceSeconds(
  submittedAt: Date,
  now: Date
): number | typeof RECHECK_POLL_TIMEOUT {
  const elapsedMs = now.getTime() - submittedAt.getTime();
  const elapsedSeconds = elapsedMs / 1000;

  if (elapsedSeconds > 2 * 60 * 60) {
    return RECHECK_POLL_TIMEOUT;
  }
  if (elapsedSeconds < 9 * 60) {
    return 180;
  }
  if (elapsedSeconds < 24 * 60) {
    return 300;
  }
  return 600;
}
