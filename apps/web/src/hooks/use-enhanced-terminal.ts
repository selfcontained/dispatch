import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

type AgentSettingsResponse = {
  enhancedTerminal: boolean;
};

export function useEnhancedTerminal(): {
  enhancedTerminal: boolean;
  setEnhancedTerminal: (enabled: boolean) => void;
  isSaving: boolean;
  saveError: boolean;
} {
  const queryClient = useQueryClient();

  const { data } = useQuery<AgentSettingsResponse>({
    queryKey: ["agents-settings"],
    queryFn: async () => {
      const res = await fetch("/api/v1/agents/settings");
      if (!res.ok) throw new Error("Failed to fetch settings");
      return res.json();
    },
  });

  const mutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await fetch("/api/v1/agents/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enhancedTerminal: enabled }),
      });
      if (!res.ok) throw new Error("Failed to save enhanced terminal setting");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents-settings"] });
    },
  });

  const setEnhancedTerminal = useCallback(
    (enabled: boolean) => {
      mutation.mutate(enabled);
    },
    [mutation]
  );

  return useMemo(
    () => ({
      enhancedTerminal: data?.enhancedTerminal ?? false,
      setEnhancedTerminal,
      isSaving: mutation.isPending,
      saveError: mutation.isError,
    }),
    [
      data?.enhancedTerminal,
      mutation.isError,
      mutation.isPending,
      setEnhancedTerminal,
    ]
  );
}
