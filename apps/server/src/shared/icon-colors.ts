/**
 * Brand icon colour palette.
 *
 * Single source of truth shared by the server (settings validation and the
 * static theme runtime), the web client (Appearance settings swatches — see
 * apps/web/src/hooks/use-icon-color.ts) and scripts/generate-icon-colors.ts,
 * which renders the SVG/PNG variants under apps/web/public/icons/. Web and the
 * script import this module directly across the workspace boundary, so keep it
 * dependency-free: no node imports, no browser globals.
 *
 * Order matters — it drives the swatch order rendered in Appearance settings.
 */

export const ICON_COLOR_PALETTE = [
  { id: "teal", primary: "#14B981", dark: "#0D8358" },
  { id: "blue", primary: "#3B82F6", dark: "#2563EB" },
  { id: "purple", primary: "#8B5CF6", dark: "#6D28D9" },
  { id: "red", primary: "#EF4444", dark: "#B91C1C" },
  { id: "orange", primary: "#F97316", dark: "#C2410C" },
  { id: "amber", primary: "#F59E0B", dark: "#B45309" },
  { id: "pink", primary: "#EC4899", dark: "#BE185D" },
  { id: "cyan", primary: "#06B6D4", dark: "#0E7490" },
] as const;

export type IconColorId = (typeof ICON_COLOR_PALETTE)[number]["id"];

export const ICON_COLOR_IDS: readonly IconColorId[] = ICON_COLOR_PALETTE.map(
  (color) => color.id
);
