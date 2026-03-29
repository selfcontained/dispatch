import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

const ACTIVITY_QUERY_OPTIONS = {
  staleTime: 60_000,
  refetchOnMount: "always" as const,
};

type HeatmapDay = { day: string; count: number };

export type ActivityStats = {
  totalWorkingMs: number;
  avgBlockedMs: number;
  avgWaitingMs: number;
  blockedRatio: number;
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

export function useActivityStats() {
  return useQuery<ActivityStats>({
    queryKey: ["activity", "stats"],
    queryFn: () => api<ActivityStats>("/api/v1/activity/stats"),
    ...ACTIVITY_QUERY_OPTIONS,
  });
}

export function useDailyStatus(days = 30) {
  return useQuery<DailyStatusEntry[]>({
    queryKey: ["activity", "daily-status", days],
    queryFn: async () => {
      const payload = await api<{ days: DailyStatusEntry[] }>(
        `/api/v1/activity/daily-status?days=${days}`
      );
      return payload.days;
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

export function useTokenStats() {
  return useQuery<TokenStats>({
    queryKey: ["activity", "token-stats"],
    queryFn: () => api<TokenStats>("/api/v1/activity/token-stats"),
    ...ACTIVITY_QUERY_OPTIONS,
  });
}

export function useTokenDaily(days = 30) {
  return useQuery<TokenDailyEntry[]>({
    queryKey: ["activity", "token-daily", days],
    queryFn: async () => {
      const payload = await api<{ days: TokenDailyEntry[] }>(
        `/api/v1/activity/token-daily?days=${days}`
      );
      return payload.days;
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

export function useTokenByModel() {
  return useQuery<TokenByModel[]>({
    queryKey: ["activity", "token-by-model"],
    queryFn: async () => {
      const payload = await api<{ models: TokenByModel[] }>("/api/v1/activity/token-by-model");
      return payload.models;
    },
    ...ACTIVITY_QUERY_OPTIONS,
  });
}

export function useTokenByProject() {
  return useQuery<TokenByProject[]>({
    queryKey: ["activity", "token-by-project"],
    queryFn: async () => {
      const payload = await api<{ projects: TokenByProject[] }>("/api/v1/activity/token-by-project");
      return payload.projects;
    },
    ...ACTIVITY_QUERY_OPTIONS,
  });
}
