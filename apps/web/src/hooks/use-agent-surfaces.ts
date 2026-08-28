import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type {
  Surface,
  SurfaceInteractionRequest,
  SurfaceInteractionResponse,
} from "@/components/app/agent-surfaces/types";

type SurfacesPayload = { surfaces: Surface[] };

export function surfacesQueryKey(agentId: string | null) {
  return ["agent-surfaces", agentId];
}

/**
 * Agent-authored custom tabs for the sidebar's second tab row. Sorted by the
 * server's canonical `sortOrder` — presentation-layer reordering/hiding is a
 * separate concern, see use-surface-tab-prefs.ts.
 */
export function useAgentSurfaces(agentId: string | null) {
  const { data, isLoading, isError, refetch } = useQuery<SurfacesPayload>({
    queryKey: surfacesQueryKey(agentId),
    queryFn: () => api<SurfacesPayload>(`/api/v1/agents/${agentId}/surfaces`),
    enabled: !!agentId,
    staleTime: 0,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  const surfaces = data?.surfaces ?? [];
  const sorted =
    surfaces.length > 1
      ? [...surfaces].sort((a, b) => a.sortOrder - b.sortOrder)
      : surfaces;

  return { surfaces: sorted, isLoading, isError, refetch };
}

export function makeIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `ix_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
}

/**
 * Submits one action click or form submission. The response only means
 * Dispatch durably queued the interaction, not that the owning agent acted on
 * it — callers should render `delivery`/`interaction.status` as a pending
 * state, not a completion. Invalidates the surfaces query on success so a
 * follow-up `resolveInteraction` doc update (if the agent is already idle and
 * fast) is picked up promptly; the SSE `surface.changed` handler covers the
 * general case.
 */
export function useSubmitSurfaceInteraction(
  agentId: string | null,
  surfaceId: string | null
) {
  const queryClient = useQueryClient();

  return useMutation<
    SurfaceInteractionResponse,
    Error,
    SurfaceInteractionRequest
  >({
    mutationFn: async (request) => {
      if (!agentId || !surfaceId) {
        throw new Error("Missing agent or surface id");
      }
      return api<SurfaceInteractionResponse>(
        `/api/v1/agents/${agentId}/surfaces/${surfaceId}/interactions`,
        {
          method: "POST",
          body: JSON.stringify(request),
        }
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: surfacesQueryKey(agentId),
        exact: true,
      });
    },
  });
}
