import type { AgentReviewSummary } from "@dispatch/shared";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

export const AGENT_REVIEWS_QUERY_KEY = ["agent-reviews"] as const;

/** One shared query, independent of which lineage's stream is open. */
export function useAgentReviewSummary(enabled = true) {
  return useQuery<AgentReviewSummary>({
    queryKey: AGENT_REVIEWS_QUERY_KEY,
    queryFn: () => api<AgentReviewSummary>("/api/v1/chat/reviews"),
    enabled,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}
