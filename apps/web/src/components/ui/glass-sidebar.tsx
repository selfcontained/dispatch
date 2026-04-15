/**
 * GlassSidebar — shared layout primitive for frosted glass sidebars.
 *
 * Handles two modes:
 *   - Desktop: inline collapsible panel with configurable width, animated via CSS width transition
 *   - Mobile: full-screen slide-over with backdrop overlay and slide animation
 *
 * The glass panel styling (frosted gradient, luminous borders, inner highlights)
 * comes from the shared glass tokens so all sidebars look identical.
 */
import { type ReactNode, useEffect } from "react";

import { cn } from "@/lib/utils";
import { glassPanel } from "@/lib/glass";

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
function DesktopSidebar({ open, side, width = 320, className, children }: Pick<GlassSidebarProps, "open" | "side" | "width" | "className" | "children">) {
  const borderSide = side === "left" ? "border-r" : "border-l";
  const shadowSide = side === "left"
    ? "shadow-[4px_0_24px_rgba(0,0,0,0.3)]"
    : "shadow-[-4px_0_24px_rgba(0,0,0,0.3)]";

  return (
    <div
      className="h-full min-w-0 flex-none overflow-hidden transition-[width] duration-300 ease-out"
      style={{ width: open ? width : 0 }}
    >
      <div
        className={cn(
          `flex h-full min-h-0 flex-col ${borderSide} ${glassPanel} text-foreground ${shadowSide}`,
          className
        )}
        style={{ width }}
      >
        {children}
      </div>
    </div>
  );
}

/** Mobile: full-screen slide-over with backdrop */
function MobileSidebar({ open, onOpenChange, side, label, className, children }: Omit<GlassSidebarProps, "width" | "mobile">) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onOpenChange, open]);

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          "fixed inset-0 z-50 bg-black/50 backdrop-blur-md transition-opacity duration-300",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={() => onOpenChange(false)}
      />
      {/* Panel */}
      <div
        className={cn(
          "fixed inset-y-0 z-[60] h-dvh w-screen transition-transform duration-300",
          side === "left" ? "left-0" : "right-0",
          open
            ? "translate-x-0"
            : side === "left"
              ? "pointer-events-none -translate-x-full"
              : "pointer-events-none translate-x-full"
        )}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        <div
          className={cn(
            `flex h-full min-h-0 w-full flex-col ${glassPanel} text-foreground`,
            className
          )}
        >
          {children}
        </div>
      </div>
    </>
  );
}

export function GlassSidebar({ mobile = false, ...props }: GlassSidebarProps) {
  if (mobile) {
    return <MobileSidebar {...props} />;
  }
  return <DesktopSidebar {...props} />;
}
