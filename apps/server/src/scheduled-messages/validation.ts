import * as z from "zod/v4";
export const LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const scheduleMessageSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(8000),
  deliver_at: z.iso.datetime({ offset: true }),
  interval_seconds: z.number().int().min(60).optional(),
  stop_when: z.string().trim().min(1).max(2000).optional(),
  max_deliveries: z.number().int().min(1).max(100).optional(),
  expires_at: z.iso.datetime({ offset: true }).optional(),
});
export type ScheduleMessageInput = z.infer<typeof scheduleMessageSchema>;
export function validateSchedule(input: ScheduleMessageInput, now: number) {
  const first = Date.parse(input.deliver_at);
  const expiry = input.expires_at
    ? Date.parse(input.expires_at)
    : now + LIFETIME_MS;
  if (first <= now) throw new Error("deliver_at must be in the future.");
  if (expiry > now + LIFETIME_MS || first > now + LIFETIME_MS)
    throw new Error("Schedules cannot extend beyond seven days from creation.");
  if (expiry <= first) throw new Error("expires_at must be after deliver_at.");
  if (
    input.interval_seconds &&
    (!input.stop_when || (!input.max_deliveries && !input.expires_at))
  )
    throw new Error(
      "Recurring schedules require stop_when and max_deliveries or expires_at."
    );
  return {
    first: new Date(first).toISOString(),
    expiry: new Date(expiry).toISOString(),
  };
}
export function nextBoundary(
  first: string,
  interval: number,
  now: number
): string {
  const start = Date.parse(first);
  return new Date(
    start > now
      ? start
      : start +
          (Math.floor((now - start) / (interval * 1000)) + 1) * interval * 1000
  ).toISOString();
}
