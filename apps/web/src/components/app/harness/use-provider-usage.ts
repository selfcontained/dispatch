import { useQuery } from "@tanstack/react-query";
import type { HarnessProviderUsageReport } from "@dispatch/shared";

import { api } from "@/lib/api";

export const HARNESS_PROVIDER_USAGE_QUERY_KEY = [
  "harness-provider-usage",
] as const;

export function useHarnessProviderUsage(enabled: boolean) {
  return useQuery({
    queryKey: HARNESS_PROVIDER_USAGE_QUERY_KEY,
    queryFn: () =>
      api<HarnessProviderUsageReport>("/api/v1/harness/provider-usage"),
    enabled,
    staleTime: 60_000,
  });
}
