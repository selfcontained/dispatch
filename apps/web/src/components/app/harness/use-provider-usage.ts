import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { HarnessProviderUsageReport } from "@dispatch/shared";

import { api } from "@/lib/api";

export const HARNESS_PROVIDER_USAGE_QUERY_KEY = [
  "harness-provider-usage",
] as const;

const PROVIDER_USAGE_URL = "/api/v1/harness/provider-usage";

export function useHarnessProviderUsage(enabled: boolean) {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const query = useQuery({
    queryKey: HARNESS_PROVIDER_USAGE_QUERY_KEY,
    queryFn: () => api<HarnessProviderUsageReport>(PROVIDER_USAGE_URL),
    enabled,
    staleTime: 60_000,
    refetchInterval: enabled ? 60_000 : false,
  });
  /**
   * The Refresh button. A plain refetch is answered from the server's
   * minute-long report cache, so a click looked like it did nothing;
   * `refresh=1` asks the server for a real attempt at the provider.
   */
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const report = await api<HarnessProviderUsageReport>(
        `${PROVIDER_USAGE_URL}?refresh=1`
      );
      queryClient.setQueryData(HARNESS_PROVIDER_USAGE_QUERY_KEY, report);
    } catch {
      // The report on screen stays; the scheduled refetch will try again.
    } finally {
      setRefreshing(false);
    }
  }, [queryClient]);
  return { ...query, refresh, refreshing };
}
