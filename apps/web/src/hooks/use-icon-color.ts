import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

/**
 * Palette ids and swatch hexes come from the shared server module so the web
 * client always matches what the server accepts and what the icon generator
 * renders (see apps/server/src/shared/icon-colors.ts). Display labels are
 * web-only and live here.
 */
import {
  ICON_COLOR_PALETTE,
  type IconColorId,
} from "../../../server/src/shared/icon-colors";

export type { IconColorId };

const ICON_COLOR_LABELS: Record<IconColorId, string> = {
  teal: "Teal",
  blue: "Blue",
  purple: "Purple",
  red: "Red",
  orange: "Orange",
  amber: "Amber",
  pink: "Pink",
  cyan: "Cyan",
};

export type IconColorDefinition = {
  id: IconColorId;
  label: string;
  swatch: string;
};

export const ICON_COLOR_OPTIONS: IconColorDefinition[] = ICON_COLOR_PALETTE.map(
  (color) => ({
    id: color.id,
    label: ICON_COLOR_LABELS[color.id],
    swatch: color.primary,
  })
);

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
    [mutation]
  );

  const clearError = useCallback(() => {
    mutation.reset();
  }, [mutation]);

  return {
    iconColor: data?.iconColor ?? "teal",
    setIconColor,
    isLoading: mutation.isPending,
    error: mutation.isError
      ? "Failed to save icon color. Please try again."
      : null,
    clearError,
  };
}
