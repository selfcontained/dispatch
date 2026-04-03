import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export function useInstanceName(): {
  instanceName: string;
  setInstanceName: (name: string) => void;
  isSaving: boolean;
  saveError: boolean;
  didSave: boolean;
  clearSaveState: () => void;
} {
  const queryClient = useQueryClient();

  const { data } = useQuery<{ instanceName: string }>({
    queryKey: ["agents-settings"],
    queryFn: async () => {
      const res = await fetch("/api/v1/agents/settings");
      if (!res.ok) throw new Error("Failed to fetch settings");
      return res.json();
    },
  });

  const mutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch("/api/v1/agents/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceName: name }),
      });
      if (!res.ok) throw new Error("Failed to save instance name");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents-settings"] });
    },
  });

  const setInstanceName = useCallback(
    (name: string) => {
      mutation.mutate(name);
    },
    [mutation],
  );

  const clearSaveState = useCallback(() => {
    mutation.reset();
  }, [mutation]);

  return {
    instanceName: data?.instanceName ?? "",
    setInstanceName,
    isSaving: mutation.isPending,
    saveError: mutation.isError,
    didSave: mutation.isSuccess,
    clearSaveState,
  };
}
