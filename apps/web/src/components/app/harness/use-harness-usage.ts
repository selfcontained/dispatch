import { useQuery } from "@tanstack/react-query";
import type { HarnessUsageReport } from "@dispatch/shared";

import { api } from "@/lib/api";

export const HARNESS_USAGE_QUERY_KEY = ["harness-usage"] as const;

/** The engines' tokens and cost this month; fetched while the dialog is open. */
export function useHarnessUsage(enabled: boolean) {
  return useQuery({
    queryKey: HARNESS_USAGE_QUERY_KEY,
    queryFn: () => api<HarnessUsageReport>("/api/v1/harness/usage"),
    enabled,
    staleTime: 60_000,
  });
}
