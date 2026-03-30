export type ActiveHourEvent = {
  created_at: string;
};

export type ActiveHoursCell = {
  dayOfWeek: number;
  hour: number;
  count: number;
  avgPerWeek: number;
};

export function buildActiveHours(
  events: ActiveHourEvent[],
  now = new Date()
): ActiveHoursCell[] {
  const counts = new Map<string, number>();
  let firstTimestamp = Number.POSITIVE_INFINITY;
  let lastTimestamp = Number.NEGATIVE_INFINITY;

  for (const event of events) {
    const date = new Date(event.created_at);
    const timestamp = date.getTime();
    if (Number.isNaN(timestamp)) continue;

    firstTimestamp = Math.min(firstTimestamp, timestamp);
    lastTimestamp = Math.max(lastTimestamp, timestamp);

    const key = `${date.getDay()}:${date.getHours()}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const effectiveStartMs = Number.isFinite(firstTimestamp) ? firstTimestamp : now.getTime();
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
