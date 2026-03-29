export type ActivityGranularity = "day" | "week" | "month";

export type ActivityEventRow = {
  agent_id: string;
  event_type: string;
  created_at: Date;
};

export type ActivityStatsResult = {
  totalWorkingMs: number;
  avgBlockedMs: number;
  avgWaitingMs: number;
  stateDurations: Record<string, number>;
};

export type ActiveHoursCell = {
  dayOfWeek: number;
  hour: number;
  count: number;
  avgPerWeek: number;
};

const ACTIVE_HOURS_EVENT_TYPES = new Set(["working", "blocked", "waiting_user"]);

function bucketStart(timeMs: number, granularity: ActivityGranularity): string {
  const bucket = new Date(timeMs);
  if (granularity === "week") {
    const day = bucket.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    bucket.setUTCDate(bucket.getUTCDate() + diff);
  } else if (granularity === "month") {
    bucket.setUTCDate(1);
  }
  return bucket.toISOString().slice(0, 10);
}

export function computeActivityStats(
  rows: ActivityEventRow[],
  rangeStart: Date | null
): ActivityStatsResult {
  const rangeStartMs = rangeStart?.getTime() ?? null;
  const stateDurations: Record<string, number> = {
    working: 0,
    blocked: 0,
    waiting_user: 0,
  };
  const sessionBlockedTimes: number[] = [];
  const sessionWaitingTimes: number[] = [];

  let prevAgentId: string | null = null;
  let prevType: string | null = null;
  let prevTime: number | null = null;
  let sessionBlocked = 0;
  let sessionWaiting = 0;
  let sawInRangeEvent = false;

  const flushSession = () => {
    if (sawInRangeEvent) {
      sessionBlockedTimes.push(sessionBlocked);
      sessionWaitingTimes.push(sessionWaiting);
    }
    sessionBlocked = 0;
    sessionWaiting = 0;
    sawInRangeEvent = false;
  };

  for (const row of rows) {
    const t = row.created_at.getTime();

    if (row.agent_id !== prevAgentId) {
      if (prevAgentId) {
        flushSession();
      }
      prevAgentId = row.agent_id;
      prevType = row.event_type;
      prevTime = t;
      sawInRangeEvent = rangeStartMs === null || t >= rangeStartMs;
      continue;
    }

    const currentInRange = rangeStartMs === null || t >= rangeStartMs;
    sawInRangeEvent ||= currentInRange;

    if (prevType && prevTime !== null && prevType !== "done" && prevType !== "idle") {
      const segmentStart = rangeStartMs === null ? prevTime : Math.max(prevTime, rangeStartMs);
      const dur = t - segmentStart;
      if (dur > 0) {
        stateDurations[prevType] = (stateDurations[prevType] ?? 0) + dur;
        if (prevType === "blocked") sessionBlocked += dur;
        if (prevType === "waiting_user") sessionWaiting += dur;
      }
    }

    if (row.event_type === "done" || row.event_type === "idle") {
      flushSession();
      prevType = row.event_type;
      prevTime = t;
      sawInRangeEvent = false;
      continue;
    }

    if (prevType === "done" || prevType === "idle") {
      sessionBlocked = 0;
      sessionWaiting = 0;
      sawInRangeEvent = currentInRange;
    }

    prevType = row.event_type;
    prevTime = t;
  }

  if (prevAgentId) {
    flushSession();
  }

  const avg = (arr: number[]) =>
    arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

  return {
    totalWorkingMs: stateDurations.working ?? 0,
    avgBlockedMs: avg(sessionBlockedTimes),
    avgWaitingMs: avg(sessionWaitingTimes),
    stateDurations,
  };
}

export function computeDailyStatus(
  rows: ActivityEventRow[],
  rangeStart: Date | null,
  granularity: ActivityGranularity
): Array<Record<string, number | string>> {
  const rangeStartMs = rangeStart?.getTime() ?? null;
  const dailyMap = new Map<string, Record<string, number>>();

  let prevAgentId: string | null = null;
  let prevType: string | null = null;
  let prevTime: number | null = null;

  for (const row of rows) {
    const t = row.created_at.getTime();
    if (row.agent_id !== prevAgentId) {
      prevAgentId = row.agent_id;
      prevType = row.event_type;
      prevTime = t;
      continue;
    }

    if (prevType && prevTime !== null && prevType !== "done" && prevType !== "idle") {
      const segmentStart = rangeStartMs === null ? prevTime : Math.max(prevTime, rangeStartMs);
      const dur = t - segmentStart;
      if (dur > 0) {
        const dayKey = bucketStart(segmentStart, granularity);
        let entry = dailyMap.get(dayKey);
        if (!entry) {
          entry = {};
          dailyMap.set(dayKey, entry);
        }
        entry[prevType] = (entry[prevType] ?? 0) + dur;
      }
    }

    prevType = row.event_type;
    prevTime = t;
  }

  return Array.from(dailyMap.entries())
    .map(([day, durations]) => ({ day, ...durations }))
    .sort((a, b) => String(a.day).localeCompare(String(b.day)));
}

export function computeActiveHours(
  rows: Array<Pick<ActivityEventRow, "event_type" | "created_at">>,
  rangeStart: Date | null,
  now = new Date()
): ActiveHoursCell[] {
  const counts = new Map<string, number>();
  const rangeStartMs = rangeStart?.getTime() ?? null;
  let firstTimestamp = Number.POSITIVE_INFINITY;
  let lastTimestamp = Number.NEGATIVE_INFINITY;

  for (const row of rows) {
    const timestamp = row.created_at.getTime();
    if (rangeStartMs !== null && timestamp < rangeStartMs) continue;
    if (!ACTIVE_HOURS_EVENT_TYPES.has(row.event_type)) continue;

    firstTimestamp = Math.min(firstTimestamp, timestamp);
    lastTimestamp = Math.max(lastTimestamp, timestamp);

    const key = `${row.created_at.getUTCDay()}:${row.created_at.getUTCHours()}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const effectiveStartMs = rangeStartMs ?? (Number.isFinite(firstTimestamp) ? firstTimestamp : now.getTime());
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
