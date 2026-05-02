import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

export type AgentSettings = {
  copyModeAssistEnabled: boolean;
};

export const AGENT_SETTINGS_QUERY_KEY = ["agents-settings"] as const;

export function useAgentSettings() {
  return useQuery<AgentSettings>({
    queryKey: AGENT_SETTINGS_QUERY_KEY,
    queryFn: () => api<AgentSettings>("/api/v1/agents/settings"),
    refetchOnWindowFocus: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
