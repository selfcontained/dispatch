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

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function getGranularity(range: ActivityRange): ActivityGranularity {
  if (range === "7d" || range === "30d") return "day";
  return "month";
}

function getRangeBounds(range: ActivityRange): { start: string; end: string } {
  const now = new Date();
  const end = now.toISOString();

  if (range === "year") {
    const yearStart = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    return { start: yearStart.toISOString(), end };
  }
  if (range === "7d") {
    return { start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(), end };
  }
  if (range === "30d") {
    return { start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(), end };
  }
  // "all" — no bounds
  return { start: "", end: "" };
}

function activityParams(range: ActivityRange): string {
  const { start, end } = getRangeBounds(range);
  const granularity = getGranularity(range);
  const params = new URLSearchParams({ tz: LOCAL_TZ, granularity });
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  return params.toString();
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
      const params = new URLSearchParams({ days: String(days), tz: LOCAL_TZ });
      const payload = await api<{ days: HeatmapDay[] }>(
        `/api/v1/activity/heatmap?${params}`
      );
      return payload.days;
    },
    ...ACTIVITY_QUERY_OPTIONS,
  });
}

export function useActivityStats(range: ActivityRange) {
  return useQuery<ActivityStats>({
    queryKey: ["activity", "stats", range],
    queryFn: () => api<ActivityStats>(`/api/v1/activity/stats?${activityParams(range)}`),
    ...ACTIVITY_QUERY_OPTIONS,
  });
}

export function useDailyStatus(range: ActivityRange) {
  return useQuery<BucketedActivityResponse<DailyStatusEntry>>({
    queryKey: ["activity", "daily-status", range],
    queryFn: () =>
      api<BucketedActivityResponse<DailyStatusEntry>>(
        `/api/v1/activity/daily-status?${activityParams(range)}`
      ),
    ...ACTIVITY_QUERY_OPTIONS,
  });
}

export function useActiveHours(range: ActivityRange) {
  return useQuery<ActiveHoursCell[]>({
    queryKey: ["activity", "active-hours", range],
    queryFn: async () => {
      const { start, end } = getRangeBounds(range);
      const params = new URLSearchParams({ tz: LOCAL_TZ });
      if (start) params.set("start", start);
      if (end) params.set("end", end);
      const payload = await api<{ events: ActiveHourEvent[] }>(
        `/api/v1/activity/active-hours?${params}`
      );
      return buildActiveHours(payload.events);
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
    queryFn: () => api<TokenStats>(`/api/v1/activity/token-stats?${activityParams(range)}`),
    ...ACTIVITY_QUERY_OPTIONS,
  });
}

export function useTokenDaily(range: ActivityRange) {
  return useQuery<BucketedActivityResponse<TokenDailyEntry>>({
    queryKey: ["activity", "token-daily", range],
    queryFn: () =>
      api<BucketedActivityResponse<TokenDailyEntry>>(
        `/api/v1/activity/token-daily?${activityParams(range)}`
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

export function useTokenByModel(range: ActivityRange) {
  return useQuery<TokenByModel[]>({
    queryKey: ["activity", "token-by-model", range],
    queryFn: async () => {
      const payload = await api<{ models: TokenByModel[] }>(
        `/api/v1/activity/token-by-model?${activityParams(range)}`
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
        `/api/v1/activity/token-by-project?${activityParams(range)}`
      );
      return payload.projects;
    },
    ...ACTIVITY_QUERY_OPTIONS,
  });
}

// ── Event-derived metrics ────────────────────────────────────────

export type AgentsCreatedEntry = { day: string; count: number };
export type AgentsCreatedResponse = {
  days: AgentsCreatedEntry[];
  total: number;
  granularity: ActivityGranularity;
};

export function useAgentsCreated(range: ActivityRange) {
  return useQuery<AgentsCreatedResponse>({
    queryKey: ["activity", "agents-created", range],
    queryFn: () =>
      api<AgentsCreatedResponse>(
        `/api/v1/activity/agents-created?${activityParams(range)}`
      ),
    ...ACTIVITY_QUERY_OPTIONS,
  });
}

export type WorkingTimeByProject = {
  project_dir: string;
  working_time_ms: number;
};

export function useWorkingTimeByProject(range: ActivityRange) {
  return useQuery<WorkingTimeByProject[]>({
    queryKey: ["activity", "working-time-by-project", range],
    queryFn: async () => {
      const payload = await api<{ projects: WorkingTimeByProject[] }>(
        `/api/v1/activity/working-time-by-project?${activityParams(range)}`
      );
      return payload.projects;
    },
    ...ACTIVITY_QUERY_OPTIONS,
  });
}
