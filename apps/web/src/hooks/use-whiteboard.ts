import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

export type WhiteboardData = {
  scene: { elements: unknown[] };
  version: number;
  updatedAt: string | null;
};

export function whiteboardQueryKey(agentId: string): [string, string] {
  return ["whiteboard", agentId];
}

// staleTime: Infinity — SSE (whiteboard.changed / reconnect snapshot)
// drives invalidation; the local editor owns all other changes.
export function useWhiteboard(agentId: string | null) {
  return useQuery({
    queryKey: whiteboardQueryKey(agentId ?? ""),
    queryFn: () => api<WhiteboardData>(`/api/v1/agents/${agentId}/whiteboard`),
    enabled: !!agentId,
    staleTime: Infinity,
  });
}
