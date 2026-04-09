import { Cron } from "croner";

/** Minimum allowed interval between cron runs (5 minutes). */
const MIN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Get the next scheduled run time for a cron expression.
 * Returns null if the expression is invalid.
 */
export function getNextRun(schedule: string): Date | null {
  try {
    const job = new Cron(schedule);
    return job.nextRun();
  } catch {
    return null;
  }
}

/**
 * Validate a cron expression. Returns true if valid, false otherwise.
 */
export function validateCronExpression(schedule: string): boolean {
  try {
    new Cron(schedule);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check that a cron expression doesn't schedule runs more frequently than
 * every 5 minutes. Returns an error message if the interval is too short,
 * or null if the schedule is acceptable.
 */
export function validateCronInterval(schedule: string): string | null {
  try {
    const cron = new Cron(schedule);
    const first = cron.nextRun();
    if (!first) return null;
    const second = cron.nextRun(first);
    if (!second) return null;
    const gap = second.getTime() - first.getTime();
    if (gap < MIN_INTERVAL_MS) {
      return `Schedule runs too frequently (every ${Math.round(gap / 1000)}s). Minimum interval is 5 minutes.`;
    }
    return null;
  } catch {
    return "Invalid cron expression.";
  }
}
