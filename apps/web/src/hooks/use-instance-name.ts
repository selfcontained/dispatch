import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

const queryKey = ["agents-settings"];
const endpoint = "/api/v1/agents/settings";

export function useInstanceName(): {
  instanceName: string;
  loaded: boolean;
  loadError: unknown;
  retryLoad: () => void;
  /** Rejects when the server didn't take it. */
  saveInstanceName: (name: string) => Promise<void>;
} {
  const queryClient = useQueryClient();
  const { data, error, refetch } = useQuery({
    queryKey,
    queryFn: () => api<{ instanceName: string }>(endpoint),
  });

  const saveInstanceName = useCallback(
    async (name: string) => {
      const saved = await api<{ instanceName: string }>(endpoint, {
        method: "POST",
        body: JSON.stringify({ instanceName: name }),
      });
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData<object>(queryKey, (current) => ({
        ...current,
        ...saved,
      }));
    },
    [queryClient]
  );

  return {
    instanceName: data?.instanceName ?? "",
    loaded: data !== undefined,
    loadError: data ? null : error,
    retryLoad: () => void refetch(),
    saveInstanceName,
  };
}
