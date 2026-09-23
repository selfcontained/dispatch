import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
const ACTIVITY_QUERY_OPTIONS = {
  staleTime: 60_000,
  refetchOnMount: "always" as const,
};

export const ACTIVITY_RANGES = ["daily", "7d", "30d", "year", "all"] as const;
export type ActivityRange = (typeof ACTIVITY_RANGES)[number];
export type ActivityGranularity = "hour" | "day" | "week" | "month";

export function rangeLabel(range: ActivityRange): string {
  switch (range) {
    case "daily":
      return "Daily";
    case "7d":
      return "Last 7 days";
    case "30d":
      return "Last 30 days";
    case "year":
      return "This year";
    case "all":
      return "All time";
  }
}

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function getGranularity(range: ActivityRange): ActivityGranularity {
  if (range === "daily") return "hour";
  if (range === "7d" || range === "30d") return "day";
  return "month";
}

export function getRangeBounds(
  range: ActivityRange,
  dailyDate?: string
): { start: string; end: string } {
  const now = new Date();
  const end = now.toISOString();

  if (range === "daily") {
    const dateStr = dailyDate ?? now.toISOString().slice(0, 10);
    const dayStart = new Date(`${dateStr}T00:00:00`);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    return { start: dayStart.toISOString(), end: dayEnd.toISOString() };
  }
  if (range === "year") {
    const yearStart = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    return { start: yearStart.toISOString(), end };
  }
  if (range === "7d") {
    return {
      start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      end,
    };
  }
  if (range === "30d") {
    return {
      start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      end,
    };
  }
  // "all" — no bounds
  return { start: "", end: "" };
}

function activityParams(range: ActivityRange, dailyDate?: string): string {
  const { start, end } = getRangeBounds(range, dailyDate);
  const granularity = getGranularity(range);
  const params = new URLSearchParams({ tz: LOCAL_TZ, granularity });
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  return params.toString();
}

export type BucketedActivityResponse<T> = {
  days: T[];
  granularity: ActivityGranularity;
};

// ── Token usage ───────────────────────────────────────────────────

export type TokenStats = {
  total_input: number;
  total_cache_creation: number;
  total_cache_read: number;
  total_output: number;
  total_messages: number;
  total_sessions: number;
};

export type TokenDailyEntry = {
  day: string;
  input_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  messages: number;
};

export function useTokenStats(range: ActivityRange, dailyDate?: string) {
  return useQuery<TokenStats>({
    queryKey: ["activity", "token-stats", range, dailyDate],
    queryFn: () =>
      api<TokenStats>(
        `/api/v1/activity/token-stats?${activityParams(range, dailyDate)}`
      ),
    ...ACTIVITY_QUERY_OPTIONS,
  });
}

export function useTokenDaily(range: ActivityRange, dailyDate?: string) {
  return useQuery<BucketedActivityResponse<TokenDailyEntry>>({
    queryKey: ["activity", "token-daily", range, dailyDate],
    queryFn: () =>
      api<BucketedActivityResponse<TokenDailyEntry>>(
        `/api/v1/activity/token-daily?${activityParams(range, dailyDate)}`
      ),
    ...ACTIVITY_QUERY_OPTIONS,
  });
}

export type TokenByModel = {
  model: string;
  total_input: number;
  total_cache_creation: number;
  total_cache_read: number;
  total_output: number;
  sessions: number;
};

export type TokenByProject = {
  project_dir: string;
  total_input: number;
  total_output: number;
  messages: number;
};

export function useTokenByModel(range: ActivityRange, dailyDate?: string) {
  return useQuery<TokenByModel[]>({
    queryKey: ["activity", "token-by-model", range, dailyDate],
    queryFn: async () => {
      const payload = await api<{ models: TokenByModel[] }>(
        `/api/v1/activity/token-by-model?${activityParams(range, dailyDate)}`
      );
      return payload.models;
    },
    ...ACTIVITY_QUERY_OPTIONS,
  });
}

export function useTokenByProject(range: ActivityRange, dailyDate?: string) {
  return useQuery<TokenByProject[]>({
    queryKey: ["activity", "token-by-project", range, dailyDate],
    queryFn: async () => {
      const payload = await api<{ projects: TokenByProject[] }>(
        `/api/v1/activity/token-by-project?${activityParams(range, dailyDate)}`
      );
      return payload.projects;
    },
    ...ACTIVITY_QUERY_OPTIONS,
  });
}
