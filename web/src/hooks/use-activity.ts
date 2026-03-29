import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

type HeatmapDay = { day: string; count: number };

export type ActivityStats = {
  avgTimeToDoneMs: number;
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
  });
}

export function useActivityStats() {
  return useQuery<ActivityStats>({
    queryKey: ["activity", "stats"],
    queryFn: () => api<ActivityStats>("/api/v1/activity/stats"),
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
  });
}
