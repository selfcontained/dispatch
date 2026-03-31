import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { ActivityRange } from "@/hooks/use-activity";

const HISTORY_QUERY_OPTIONS = {
  staleTime: 60_000,
  refetchOnMount: "always" as const,
};

// ── Types ──────────────────────────────────────────────────────────

export type HistoryAgent = {
  id: string;
  name: string;
  type: string;
  status: string;
  cwd: string;
  worktreePath: string | null;
  worktreeBranch: string | null;
  latestEvent: {
    type: string;
    message: string;
    updatedAt: string;
    metadata: Record<string, unknown> | null;
  } | null;
  gitContext: {
    repoRoot: string;
    branch: string;
    worktreePath: string;
    worktreeName: string;
    isWorktree: boolean;
  } | null;
  createdAt: string;
  updatedAt: string;
  durationMs: number;
  totalTokens: number;
};

export type HistoryAgentsResponse = {
  agents: HistoryAgent[];
  total: number;
  limit: number;
  offset: number;
};

export type HistoryEvent = {
  id: number;
  event_type: string;
  message: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type HistoryTokenUsage = {
  total_input: number;
  total_cache_creation: number;
  total_cache_read: number;
  total_output: number;
  total_messages: number;
  by_model: Array<{
    model: string;
    input_tokens: number;
    output_tokens: number;
  }>;
};

export type HistoryMedia = {
  file_name: string;
  source: string;
  size_bytes: number;
  description: string | null;
  created_at: string;
};

export type HistoryAgentDetail = {
  agent: Omit<HistoryAgent, "durationMs" | "totalTokens">;
  events: HistoryEvent[];
  tokenUsage: HistoryTokenUsage;
  media: HistoryMedia[];
  stateDurations: Record<string, number>;
};

// ── Filters ────────────────────────────────────────────────────────

export type HistoryFilters = {
  search: string;
  type: string;
  project: string;
  range: ActivityRange;
  sort: string;
  order: "asc" | "desc";
  offset: number;
};

function getRangeBounds(range: ActivityRange): { start: string; end: string } {
  const now = new Date();
  const end = now.toISOString();
  if (range === "year") {
    return { start: new Date(now.getFullYear(), 0, 1).toISOString(), end };
  }
  if (range === "7d") {
    return { start: new Date(now.getTime() - 7 * 86_400_000).toISOString(), end };
  }
  if (range === "30d") {
    return { start: new Date(now.getTime() - 30 * 86_400_000).toISOString(), end };
  }
  return { start: "", end: "" };
}

function buildParams(filters: HistoryFilters): string {
  const params = new URLSearchParams();
  if (filters.search) params.set("search", filters.search);
  if (filters.type) params.set("type", filters.type);
  if (filters.project) params.set("project", filters.project);
  const { start, end } = getRangeBounds(filters.range);
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  params.set("sort", filters.sort);
  params.set("order", filters.order);
  params.set("limit", "50");
  if (filters.offset > 0) params.set("offset", String(filters.offset));
  return params.toString();
}

// ── Hooks ──────────────────────────────────────────────────────────

export function useHistoryProjects() {
  return useQuery<string[]>({
    queryKey: ["history", "projects"],
    queryFn: async () => {
      const payload = await api<{ projects: string[] }>("/api/v1/history/projects");
      return payload.projects;
    },
    ...HISTORY_QUERY_OPTIONS,
  });
}

export function useHistoryAgents(filters: HistoryFilters) {
  return useQuery<HistoryAgentsResponse>({
    queryKey: ["history", "agents", filters],
    queryFn: () =>
      api<HistoryAgentsResponse>(`/api/v1/history/agents?${buildParams(filters)}`),
    ...HISTORY_QUERY_OPTIONS,
  });
}

export function useHistoryAgentDetail(agentId: string | null) {
  return useQuery<HistoryAgentDetail>({
    queryKey: ["history", "agent", agentId],
    queryFn: () => api<HistoryAgentDetail>(`/api/v1/history/agents/${agentId}`),
    enabled: !!agentId,
    ...HISTORY_QUERY_OPTIONS,
  });
}
