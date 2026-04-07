import { Cron } from "croner";

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
