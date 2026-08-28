import {
  ClipboardList,
  Clock,
  Flag,
  LayoutGrid,
  List,
  ListChecks,
  MessageSquare,
  Sparkles,
  Table as TableIcon,
  type LucideIcon,
} from "lucide-react";

import type { SurfaceIcon } from "@/components/app/agent-surfaces/types";

/**
 * Canonical SurfaceIcon -> glyph mapping. `Surface.icon` and
 * `ActionRef.icon` (types.ts) share the SurfaceIcon union, so this map is
 * the one place to look up or extend an agent-authored icon's rendering.
 */
export const SURFACE_ICON_MAP: Record<SurfaceIcon, LucideIcon> = {
  layout: LayoutGrid,
  list: List,
  table: TableIcon,
  checklist: ListChecks,
  message: MessageSquare,
  flag: Flag,
  clock: Clock,
  sparkles: Sparkles,
  form: ClipboardList,
};

/** Renders an agent-authored surface's icon, or nothing if it has none. */
export function SurfaceIconGlyph({
  icon,
  className,
}: {
  icon: SurfaceIcon | undefined;
  className?: string;
}): JSX.Element | null {
  if (!icon) return null;
  const Glyph = SURFACE_ICON_MAP[icon];
  return <Glyph className={className} aria-hidden="true" />;
}
