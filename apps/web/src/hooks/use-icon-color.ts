import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export const ICON_COLORS = ["teal", "blue", "purple", "red", "orange", "amber", "pink", "cyan"] as const;
export type IconColorId = typeof ICON_COLORS[number];

export type IconColorDefinition = {
  id: IconColorId;
  label: string;
  swatch: string;
};

export const ICON_COLOR_OPTIONS: IconColorDefinition[] = [
  { id: "teal", label: "Teal", swatch: "#14B981" },
  { id: "blue", label: "Blue", swatch: "#3B82F6" },
  { id: "purple", label: "Purple", swatch: "#8B5CF6" },
  { id: "red", label: "Red", swatch: "#EF4444" },
  { id: "orange", label: "Orange", swatch: "#F97316" },
  { id: "amber", label: "Amber", swatch: "#F59E0B" },
  { id: "pink", label: "Pink", swatch: "#EC4899" },
  { id: "cyan", label: "Cyan", swatch: "#06B6D4" },
];

export function useIconColor(): {
  iconColor: IconColorId;
  setIconColor: (id: IconColorId) => void;
  isLoading: boolean;
  error: string | null;
  clearError: () => void;
} {
  const queryClient = useQueryClient();

  const { data } = useQuery<{ iconColor: IconColorId }>({
    queryKey: ["agents-settings"],
    queryFn: async () => {
      const res = await fetch("/api/v1/agents/settings");
      if (!res.ok) throw new Error("Failed to fetch settings");
      return res.json();
    },
  });

  const mutation = useMutation({
    mutationFn: async (color: IconColorId) => {
      const res = await fetch("/api/v1/agents/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ iconColor: color }),
      });
      if (!res.ok) throw new Error("Failed to save icon color");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents-settings"] });
      // Reload to pick up server-rendered HTML with new icon paths
      window.location.reload();
    },
  });

  const setIconColor = useCallback(
    (id: IconColorId) => {
      mutation.mutate(id);
    },
    [mutation],
  );

  const clearError = useCallback(() => {
    mutation.reset();
  }, [mutation]);

  return {
    iconColor: data?.iconColor ?? "teal",
    setIconColor,
    isLoading: mutation.isPending,
    error: mutation.isError ? "Failed to save icon color. Please try again." : null,
    clearError,
  };
}
