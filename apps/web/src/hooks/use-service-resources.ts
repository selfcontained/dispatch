import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { ServiceResourcesResponse } from "../../../server/src/observability/service-resources";
import type { SubsystemHealthState } from "../../../server/src/observability/subsystem-tracker";

export type {
  ResourceSample,
  ServiceResourcesResponse,
  SubsystemResourceSample,
} from "../../../server/src/observability/service-resources";
export type { SubsystemSnapshot } from "../../../server/src/observability/subsystem-tracker";

/**
 * Every state the resource dashboard renders a badge for: the subsystem states
 * plus the `unavailable` that only `overall` and `database` report.
 */
export type ResourceHealthState = SubsystemHealthState | "unavailable";

export type ResourceWindow = "15m" | "1h";

const resourceQueryPrefix = ["service-resources"] as const;

function resourceQueryKey(window: ResourceWindow) {
  return [...resourceQueryPrefix, window] as const;
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

export function useSetServiceResourcesCollection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      api<{ collectionEnabled: boolean }>("/api/v1/system/resources/settings", {
        method: "POST",
        body: JSON.stringify({ enabled }),
      }),
    onMutate: async (enabled) => {
      await queryClient.cancelQueries({ queryKey: resourceQueryPrefix });
      const previous = queryClient.getQueriesData<ServiceResourcesResponse>({
        queryKey: resourceQueryPrefix,
      });
      queryClient.setQueriesData<ServiceResourcesResponse>(
        { queryKey: resourceQueryPrefix },
        (current) =>
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
      for (const [queryKey, data] of context?.previous ?? []) {
        queryClient.setQueryData(queryKey, data);
      }
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: resourceQueryPrefix }),
  });
}
