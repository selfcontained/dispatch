import type { ActivityRange } from "@/hooks/use-activity";

export type ActiveHourEvent = {
  created_at: string;
};

export type ActiveHoursCell = {
  dayOfWeek: number;
  hour: number;
  count: number;
  avgPerWeek: number;
};

function rangeStart(range: ActivityRange, now: Date): Date | null {
  if (range === "all") return null;
  if (range === "year") return new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
  if (range === "7d") return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
}

export function buildActiveHours(
  events: ActiveHourEvent[],
  range: ActivityRange,
  now = new Date()
): ActiveHoursCell[] {
  const counts = new Map<string, number>();
  const lowerBound = rangeStart(range, now);
  const lowerBoundMs = lowerBound?.getTime() ?? null;
  let firstTimestamp = Number.POSITIVE_INFINITY;
  let lastTimestamp = Number.NEGATIVE_INFINITY;

  for (const event of events) {
    const date = new Date(event.created_at);
    const timestamp = date.getTime();
    if (Number.isNaN(timestamp)) continue;
    if (lowerBoundMs !== null && timestamp < lowerBoundMs) continue;

    firstTimestamp = Math.min(firstTimestamp, timestamp);
    lastTimestamp = Math.max(lastTimestamp, timestamp);

    const key = `${date.getDay()}:${date.getHours()}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const effectiveStartMs = lowerBoundMs ?? (Number.isFinite(firstTimestamp) ? firstTimestamp : now.getTime());
  const effectiveEndMs = Number.isFinite(lastTimestamp) ? Math.max(lastTimestamp, now.getTime()) : now.getTime();
  const spanWeeks = Math.max(1, (effectiveEndMs - effectiveStartMs) / (7 * 24 * 60 * 60 * 1000));

  const cells: ActiveHoursCell[] = [];
  for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const count = counts.get(`${dayOfWeek}:${hour}`) ?? 0;
      cells.push({
        dayOfWeek,
        hour,
        count,
        avgPerWeek: Number((count / spanWeeks).toFixed(2)),
      });
    }
  }

  return cells;
}
