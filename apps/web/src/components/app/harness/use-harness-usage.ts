import { useQuery } from "@tanstack/react-query";
import type { HarnessUsageResponse } from "@dispatch/shared";

import { api } from "@/lib/api";

export const HARNESS_USAGE_QUERY_KEY = ["harness-usage"] as const;

/** The provider keys' usage this month; fetched while the dialog is open. */
export function useHarnessUsage(enabled: boolean) {
  return useQuery({
    queryKey: HARNESS_USAGE_QUERY_KEY,
    queryFn: () => api<HarnessUsageResponse>("/api/v1/harness/usage"),
    enabled,
    staleTime: 60_000,
  });
}
