import { useQuery } from "@tanstack/react-query";
import type { HarnessAuthReport } from "@dispatch/shared";

import { api } from "@/lib/api";

export const HARNESS_AUTH_QUERY_KEY = ["harness-auth"] as const;

export function useHarnessAuth(enabled: boolean) {
  return useQuery({
    queryKey: HARNESS_AUTH_QUERY_KEY,
    queryFn: () => api<HarnessAuthReport>("/api/v1/harness/auth"),
    enabled,
    staleTime: 60_000,
  });
}
