import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { AgentType } from "@/lib/agent-types";
import { api } from "@/lib/api";

export type ModelAvailability = {
  autoEnable: boolean;
  disabled: string[];
  unseen: string[];
};

export type ModelAvailabilityChange = { agentType: AgentType } & (
  | { autoEnable: boolean }
  | { model: string; enabled: boolean }
  | { seen: string[] }
);

type CachedCatalog = {
  availability?: Partial<Record<AgentType, ModelAvailability>>;
};

function applyChange(
  current: ModelAvailability,
  change: ModelAvailabilityChange
): ModelAvailability {
  if ("autoEnable" in change)
    return { ...current, autoEnable: change.autoEnable };
  if ("seen" in change)
    return {
      ...current,
      unseen: current.unseen.filter((id) => !change.seen.includes(id)),
    };
  const disabled = current.disabled.filter((id) => id !== change.model);
  if (!change.enabled) disabled.push(change.model);
  return { ...current, disabled };
}

export const MODEL_AVAILABILITY_MUTATION_KEY = ["agent-model-availability"];

/**
 * Edits the model filter. It shows at once in every picker, since they share
 * the catalog's cache entry; saves run in order, and the catalog is read
 * again after the last one. One that fails is undone at once.
 */
export function useUpdateModelAvailability() {
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, ModelAvailabilityChange>({
    mutationKey: MODEL_AVAILABILITY_MUTATION_KEY,
    scope: { id: "agent-model-availability" },
    mutationFn: (change) =>
      api("/api/v1/app/settings/agent-models", {
        method: "PATCH",
        body: JSON.stringify(change),
      }),
    onMutate: (change) => {
      void queryClient.cancelQueries({ queryKey: ["agent-models"] });
      queryClient.setQueryData<CachedCatalog>(["agent-models"], (data) => {
        const current = data?.availability?.[change.agentType];
        if (!data || !current) return data;
        return {
          ...data,
          availability: {
            ...data.availability,
            [change.agentType]: applyChange(current, change),
          },
        };
      });
    },
    // The refetch below would undo it too, unless that fails as well.
    onError: (_error, change) => {
      if ("seen" in change) return;
      const undo: ModelAvailabilityChange =
        "autoEnable" in change
          ? { agentType: change.agentType, autoEnable: !change.autoEnable }
          : { ...change, enabled: !change.enabled };
      queryClient.setQueryData<CachedCatalog>(["agent-models"], (data) => {
        const current = data?.availability?.[undo.agentType];
        if (!data || !current) return data;
        return {
          ...data,
          availability: {
            ...data.availability,
            [undo.agentType]: applyChange(current, undo),
          },
        };
      });
    },
    onSettled: () => {
      if (
        queryClient.isMutating({
          mutationKey: MODEL_AVAILABILITY_MUTATION_KEY,
        }) === 1
      )
        void queryClient.invalidateQueries({ queryKey: ["agent-models"] });
    },
  });
}
