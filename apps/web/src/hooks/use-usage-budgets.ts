import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UsageBudgets, UsageBudgetsResponse } from "@dispatch/shared";

import { HARNESS_USAGE_QUERY_KEY } from "@/components/app/harness/use-harness-usage";
import { api } from "@/lib/api";

export const USAGE_BUDGETS_ENDPOINT = "/api/v1/app/settings/usage-budgets";
export const USAGE_BUDGETS_QUERY_KEY = ["usage-budgets"] as const;

/** Monthly budgets per provider, as Settings holds them. */
export function useUsageBudgets() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: USAGE_BUDGETS_QUERY_KEY,
    queryFn: () => api<UsageBudgetsResponse>(USAGE_BUDGETS_ENDPOINT),
    staleTime: 60_000,
  });
  const save = useMutation({
    mutationFn: (budgets: UsageBudgets) =>
      api<UsageBudgetsResponse>(USAGE_BUDGETS_ENDPOINT, {
        method: "POST",
        body: JSON.stringify({ budgets }),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(USAGE_BUDGETS_QUERY_KEY, data);
      // The usage dialog draws its bars from these.
      void queryClient.invalidateQueries({ queryKey: HARNESS_USAGE_QUERY_KEY });
    },
  });
  return {
    budgets: query.data?.budgets ?? {},
    loaded: query.data !== undefined,
    save: save.mutateAsync,
    saving: save.isPending,
    error: save.error?.message ?? query.error?.message ?? null,
  };
}
