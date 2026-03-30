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

function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function bucketStart(timeMs: number, granularity: ActivityGranularity): string {
  const bucket = new Date(timeMs);
  if (granularity === "week") {
    const day = bucket.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    bucket.setDate(bucket.getDate() + diff);
  } else if (granularity === "month") {
    bucket.setDate(1);
  }
  return localDateString(bucket);
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
