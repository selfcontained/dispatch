import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  HarnessConfigChoice,
  HarnessConfigGroup,
  HarnessConfigOption,
  HarnessConfigResponse,
  HarnessConfigUpdateRequest,
} from "@dispatch/shared";

import { api } from "@/lib/api";

export function harnessConfigQueryKey(agentId: string | null) {
  return ["harness-config", agentId] as const;
}

export function isConfigGroup(
  entry: HarnessConfigChoice | HarnessConfigGroup
): entry is HarnessConfigGroup {
  return Array.isArray((entry as HarnessConfigGroup).options);
}

/** Every choice of a select option, flattened across groups. */
export function configChoices(
  option: HarnessConfigOption | undefined
): HarnessConfigChoice[] {
  if (!option) return [];
  return option.options.flatMap((entry) =>
    isConfigGroup(entry) ? entry.options : [entry]
  );
}

/** The display name of an option's current value. */
export function currentChoiceName(
  option: HarnessConfigOption | undefined
): string | null {
  if (!option) return null;
  const match = configChoices(option).find(
    (c) => c.value === option.currentValue
  );
  return match?.name ?? option.currentValue;
}

/** The live session's config (model, reasoning effort) for a harness agent. */
export function useHarnessConfig(agentId: string | null): {
  running: boolean;
  options: HarnessConfigOption[];
  model: HarnessConfigOption | undefined;
  effort: HarnessConfigOption | undefined;
  loading: boolean;
} {
  const query = useQuery({
    queryKey: harnessConfigQueryKey(agentId),
    queryFn: () =>
      api<HarnessConfigResponse>(`/api/v1/agents/${agentId}/harness/config`),
    enabled: agentId !== null,
    staleTime: 30_000,
    // The session comes up seconds after the agent does; until it has,
    // keep asking so the chip and picker do not sit on a stale "not
    // running" (SSE invalidation covers the usual path, this the rest).
    refetchInterval: (q) => (q.state.data?.running === false ? 5_000 : false),
  });
  const options = query.data?.options ?? [];
  return {
    running: query.data?.running ?? false,
    options,
    model: options.find((o) => o.id === "model"),
    effort: options.find(
      (o) => o.id === "reasoning_effort" || o.category === "thought_level"
    ),
    loading: query.isLoading,
  };
}

export function useSetHarnessConfig(agentId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<HarnessConfigResponse, Error, HarnessConfigUpdateRequest>({
    mutationFn: (body) =>
      api<HarnessConfigResponse>(`/api/v1/agents/${agentId}/harness/config`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(harnessConfigQueryKey(agentId), data);
      // A model switch shows on the agent record too.
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}
