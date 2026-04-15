/**
 * Glass design tokens — centralized surface styles for the layered glass aesthetic.
 *
 * Import these constants instead of hardcoding glass classes in components.
 * Changing values here updates the entire app's glass treatment.
 */

/** Frosted panel — sidebar, right panel, jobs sidebar */
export const glassPanel =
  "border-white/[0.18] bg-white/[0.08] backdrop-blur-2xl shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]";

/** Elevated surface — cards, stat cards, containers that float above background */
export const glassSurface =
  "border border-white/[0.15] bg-white/[0.07] backdrop-blur-xl shadow-[0_4px_24px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.12)]";

/** Overlay — dialogs, popovers, dropdowns, sheets */
export const glassOverlay =
  "border border-white/[0.2] bg-white/[0.08] backdrop-blur-2xl shadow-[0_16px_64px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.15)]";

/** Inset — inputs, textareas, select triggers (recessed feel) */
export const glassInset =
  "border border-white/[0.12] bg-white/[0.04] backdrop-blur-md shadow-[inset_0_2px_6px_rgba(0,0,0,0.3)]";

/** Divider — border color for separators inside glass panels */
export const glassDivider = "border-white/[0.12]";

/** Hover — background for interactive items on hover */
export const glassHover = "hover:bg-white/[0.08]";

/** Active/selected background */
export const glassActive = "bg-white/[0.06]";

/** Subtle inline badge/tag background (code, filenames, ports) */
export const glassBadgeBg = "bg-white/[0.08]";

/** Glow halo for primary accent elements */
export const primaryGlow = "shadow-[0_0_24px_hsl(var(--primary)/0.3)]";
