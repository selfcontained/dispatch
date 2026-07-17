import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export type ResourceHealthState =
  | "healthy"
  | "degraded"
  | "unavailable"
  | "running"
  | "idle"
  | "disabled"
  | "unknown";

export type ResourceSample = {
  at: number;
  serverCpuPercent: number;
  serverRssBytes: number;
  serverHeapBytes: number;
  agentCpuPercent: number | null;
  agentRssBytes: number | null;
  hostLoad1: number;
  subsystems: Record<string, SubsystemResourceSample>;
};

export type SubsystemResourceSample = {
  p95DurationMs: number | null;
  failures: number;
  metadata: Record<string, number>;
};

export type SubsystemSnapshot = {
  id: string;
  label: string;
  description: string;
  state: ResourceHealthState;
  statusReason: "failure" | "stale" | "stuck" | null;
  expectedCadenceMs: number | null;
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  lastSucceededAt: number | null;
  lastFailedAt: number | null;
  lastDurationMs: number | null;
  p95DurationMs: number | null;
  inFlight: number;
  runs: number;
  failures: number;
  lastError: string | null;
  metadata: Record<string, number>;
};

export type ServiceResourcesResponse = {
  collectionEnabled: boolean;
  generatedAt: number;
  processStartedAt: number;
  availableHistoryMs: number;
  sampleIntervalMs: number;
  overall: {
    state: "healthy" | "degraded" | "unavailable" | "unknown";
    reasons: Array<{ code: string; message: string }>;
  };
  capabilities: {
    processTreeMetrics: "available" | "unsupported" | "error";
    eventLoopMetrics: "available";
  };
  current: {
    server: {
      cpuPercent: number;
      rssBytes: number;
      heapUsedBytes: number;
      heapTotalBytes: number;
      externalBytes: number;
      uptimeSeconds: number;
    };
    host: {
      load1: number;
      load5: number;
      load15: number;
      cpuCount: number;
      totalMemoryBytes: number;
      freeMemoryBytes: number;
    };
    agents: {
      supported: boolean;
      cpuPercent: number | null;
      rssBytes: number | null;
      processCount: number | null;
      sampledAt: number | null;
      error: string | null;
    };
    database: {
      state: "healthy" | "unavailable" | "unknown";
      latencyMs: number | null;
      sampledAt: number | null;
      pool: { total: number; idle: number; waiting: number; max: number };
    };
    eventLoop: { p95DelayMs: number };
    http: {
      requestsPerMinute: number;
      inFlight: number;
      errorRatePercent: number;
      p95DurationMs: number | null;
    };
    workloads: {
      runningAgents: number;
      sseClients: number;
      streams: number;
      streamViewers: number;
      terminalObservers: number;
      terminalViewers: number;
      scheduledJobs: number;
      jobMonitors: number;
      gitRefreshesInFlight: number;
      uiEventsPublished: number;
      uiWriteFailures: number;
      terminalPolls: number;
      terminalPollFailures: number;
    };
  };
  subsystems: SubsystemSnapshot[];
  series: ResourceSample[];
};

export type ResourceWindow = "15m" | "1h";

function resourceQueryKey(window: ResourceWindow) {
  return ["service-resources", window] as const;
}

export function useServiceResources(window: ResourceWindow) {
  return useQuery<ServiceResourcesResponse>({
    queryKey: resourceQueryKey(window),
    queryFn: () =>
      api<ServiceResourcesResponse>(
        `/api/v1/system/resources?window=${encodeURIComponent(window)}`
      ),
    refetchInterval: () =>
      typeof document !== "undefined" && document.hidden ? false : 15_000,
    refetchIntervalInBackground: false,
    placeholderData: (previous) => previous,
  });
}

export function useSetServiceResourcesCollection(window: ResourceWindow) {
  const queryClient = useQueryClient();
  const queryKey = resourceQueryKey(window);
  return useMutation({
    mutationFn: (enabled: boolean) =>
      api<{ collectionEnabled: boolean }>("/api/v1/system/resources/settings", {
        method: "POST",
        body: JSON.stringify({ enabled }),
      }),
    onMutate: async (enabled) => {
      await queryClient.cancelQueries({ queryKey });
      const previous =
        queryClient.getQueryData<ServiceResourcesResponse>(queryKey);
      queryClient.setQueryData<ServiceResourcesResponse>(queryKey, (current) =>
        current
          ? {
              ...current,
              collectionEnabled: enabled,
              series: enabled ? current.series : [],
              availableHistoryMs: enabled ? current.availableHistoryMs : 0,
            }
          : current
      );
      return { previous };
    },
    onError: (_error, _enabled, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
}
