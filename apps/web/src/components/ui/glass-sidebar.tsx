/**
 * GlassSidebar — shared layout primitive for frosted glass sidebars.
 *
 * Handles two modes:
 *   - Desktop: inline collapsible panel with configurable width, animated via CSS width transition
 *   - Mobile: a modal Sheet
 *
 * The glass panel styling (frosted gradient, luminous borders, inner highlights)
 * comes from the shared glass tokens so all sidebars look identical.
 */
import { type ReactNode } from "react";

import { glassPanel } from "@/lib/glass";
import { cn } from "@/lib/utils";
import { Sheet } from "./sheet";

type GlassSidebarProps = {
  /** Whether the sidebar is open */
  open: boolean;
  /** Callback when open state changes (e.g. close via backdrop tap or Escape) */
  onOpenChange: (open: boolean) => void;
  /** Which side the sidebar appears on */
  side: "left" | "right";
  /** Width of the sidebar in pixels (desktop only) */
  width?: number;
  /** Whether to use mobile slide-over behavior */
  mobile?: boolean;
  /** Accessibility label for the slide-over dialog */
  label?: string;
  /** Additional className for the glass panel */
  className?: string;
  children: ReactNode;
};

/** Desktop: inline collapsible panel that animates width */
function DesktopSidebar({
  open,
  side,
  width = 320,
  className,
  children,
}: Pick<
  GlassSidebarProps,
  "open" | "side" | "width" | "className" | "children"
>) {
  const borderSide = side === "left" ? "border-r" : "border-l";
  const innerRadius = side === "left" ? "rounded-r-lg" : "rounded-l-lg";

  return (
    <div
      className="h-full min-w-0 flex-none overflow-hidden transition-[width] duration-300 ease-out"
      style={{ width: open ? width : 0 }}
    >
      <div
        className={cn(
          `flex h-full min-h-0 flex-col ${borderSide} ${innerRadius} text-foreground`,
          glassPanel,
          className
        )}
        style={{ width }}
      >
        {children}
      </div>
    </div>
  );
}

export function GlassSidebar({ mobile = false, ...props }: GlassSidebarProps) {
  if (!mobile) return <DesktopSidebar {...props} />;
  const { open, onOpenChange, side, label, className, children } = props;
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      side={side}
      label={label}
      className={className}
    >
      {children}
    </Sheet>
  );
}
