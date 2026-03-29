import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { buildActiveHours, type ActiveHourEvent, type ActiveHoursCell } from "@/lib/active-hours";

export type { ActiveHoursCell } from "@/lib/active-hours";

const ACTIVITY_QUERY_OPTIONS = {
  staleTime: 60_000,
  refetchOnMount: "always" as const,
};

type HeatmapDay = { day: string; count: number };

export const ACTIVITY_RANGES = ["7d", "30d", "year", "all"] as const;
export type ActivityRange = (typeof ACTIVITY_RANGES)[number];
export type ActivityGranularity = "day" | "week" | "month";

export function rangeLabel(range: ActivityRange): string {
  switch (range) {
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

function scopedActivityPath(path: string, range: ActivityRange): string {
  return `${path}?range=${range}`;
}

export type ActivityStats = {
  totalWorkingMs: number;
  avgBlockedMs: number;
  avgWaitingMs: number;
  busiestDay: string | null;
  busiestDayCount: number;
  stateDurations: Record<string, number>;
};

export type DailyStatusEntry = {
  day: string;
  working?: number;
  blocked?: number;
  waiting_user?: number;
  done?: number;
  idle?: number;
};

export type BucketedActivityResponse<T> = {
  days: T[];
  granularity: ActivityGranularity;
};

export function useActivityHeatmap(days = 365) {
  return useQuery<HeatmapDay[]>({
    queryKey: ["activity", "heatmap", days],
    queryFn: async () => {
      const payload = await api<{ days: HeatmapDay[] }>(
        `/api/v1/activity/heatmap?days=${days}`
      );
      return payload.days;
    },
    ...ACTIVITY_QUERY_OPTIONS,
  });
}

export function useActivityStats(range: ActivityRange) {
  return useQuery<ActivityStats>({
    queryKey: ["activity", "stats", range],
    queryFn: () => api<ActivityStats>(scopedActivityPath("/api/v1/activity/stats", range)),
    ...ACTIVITY_QUERY_OPTIONS,
  });
}

export function useDailyStatus(range: ActivityRange) {
  return useQuery<BucketedActivityResponse<DailyStatusEntry>>({
    queryKey: ["activity", "daily-status", range],
    queryFn: async () => {
      return api<BucketedActivityResponse<DailyStatusEntry>>(
        scopedActivityPath("/api/v1/activity/daily-status", range)
      );
    },
    ...ACTIVITY_QUERY_OPTIONS,
  });
}

export function useActiveHours(range: ActivityRange) {
  return useQuery<ActiveHoursCell[]>({
    queryKey: ["activity", "active-hours", range],
    queryFn: async () => {
      const payload = await api<{ events: ActiveHourEvent[] }>(
        scopedActivityPath("/api/v1/activity/active-hours", range)
      );
      return buildActiveHours(payload.events, range);
    },
    ...ACTIVITY_QUERY_OPTIONS,
  });
}

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

export function useTokenStats(range: ActivityRange) {
  return useQuery<TokenStats>({
    queryKey: ["activity", "token-stats", range],
    queryFn: () => api<TokenStats>(scopedActivityPath("/api/v1/activity/token-stats", range)),
    ...ACTIVITY_QUERY_OPTIONS,
  });
}

export function useTokenDaily(range: ActivityRange) {
  return useQuery<BucketedActivityResponse<TokenDailyEntry>>({
    queryKey: ["activity", "token-daily", range],
    queryFn: async () => {
      return api<BucketedActivityResponse<TokenDailyEntry>>(
        scopedActivityPath("/api/v1/activity/token-daily", range)
      );
    },
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

export function useTokenByModel(range: ActivityRange) {
  return useQuery<TokenByModel[]>({
    queryKey: ["activity", "token-by-model", range],
    queryFn: async () => {
      const payload = await api<{ models: TokenByModel[] }>(
        scopedActivityPath("/api/v1/activity/token-by-model", range)
      );
      return payload.models;
    },
    ...ACTIVITY_QUERY_OPTIONS,
  });
}

export function useTokenByProject(range: ActivityRange) {
  return useQuery<TokenByProject[]>({
    queryKey: ["activity", "token-by-project", range],
    queryFn: async () => {
      const payload = await api<{ projects: TokenByProject[] }>(
        scopedActivityPath("/api/v1/activity/token-by-project", range)
      );
      return payload.projects;
    },
    ...ACTIVITY_QUERY_OPTIONS,
  });
}
