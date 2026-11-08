import { useQuery } from "@tanstack/react-query";
import type { RoutingPending } from "@dispatch/shared";
import { api } from "@/lib/api";
export const routingPendingKey = (streamId: string) =>
  ["routing-pending", streamId] as const;
/** Initial/reconnect snapshot only. Lifecycle changes arrive over the shared SSE connection. */
export function useRoutingPending(streamId: string, enabled: boolean) {
  return useQuery({
    queryKey: routingPendingKey(streamId),
    queryFn: () =>
      api<{ pending: RoutingPending[] }>(
        `/api/v1/experiments/routing/pending?streamId=${encodeURIComponent(streamId)}`
      ),
    enabled,
    staleTime: Infinity,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
