import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

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

/** The reload picks up server-rendered icon paths; "Saved" shows first. */
const RELOAD_DELAY_MS = 1000;
const ENDPOINT = "/api/v1/agents/settings";

export function useIconColor(): {
  iconColor: IconColorId;
  /** Rejects when the server didn't take it. */
  saveIconColor: (id: IconColorId) => Promise<void>;
} {
  const { data } = useQuery({
    queryKey: ["agents-settings"],
    queryFn: () => api<{ iconColor: IconColorId }>(ENDPOINT),
  });

  const saveIconColor = useCallback(async (iconColor: IconColorId) => {
    await api(ENDPOINT, {
      method: "POST",
      body: JSON.stringify({ iconColor }),
    });
    window.setTimeout(() => window.location.reload(), RELOAD_DELAY_MS);
  }, []);

  return { iconColor: data?.iconColor ?? "teal", saveIconColor };
}
