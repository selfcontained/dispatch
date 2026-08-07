import { ChevronDown, ChevronUp } from "lucide-react";
import { useAtom } from "jotai";

import { AmbientTipBar } from "@/components/tips/ambient-tip-bar";
import { bottomBarCollapsedAtom } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * Desktop-only bar under the center pane, hosting the ambient tip bar.
 * Collapsible (not removable) to free vertical space for the content area;
 * the collapsed state persists per device. The toggle is a single
 * always-mounted button so keyboard focus survives the collapse/expand
 * swap — only the strip itself unmounts.
 */
export function BottomBar(): JSX.Element {
  const [collapsed, setCollapsed] = useAtom(bottomBarCollapsedAtom);

  return (
    <>
      {!collapsed ? (
        <div
          data-testid="bottom-bar"
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-14 bg-background"
        >
          {/* pr-12 keeps the tip bar's dismiss actions clear of the toggle. */}
          <div className="h-full min-w-0 pr-12">
            <AmbientTipBar />
          </div>
        </div>
      ) : null}
      {/* z-30: with the bar collapsed the terminal pane reaches the bottom
          edge, and its inert/empty overlays are z-20 — the toggle must stay
          clickable above them. h-11/w-11 gives a 44px hit target around the
          deliberately subtle chevron. */}
      <button
        type="button"
        onClick={() => setCollapsed((prev) => !prev)}
        title={collapsed ? "Expand bottom bar" : "Collapse bottom bar"}
        aria-label={collapsed ? "Expand bottom bar" : "Collapse bottom bar"}
        aria-expanded={!collapsed}
        data-testid="bottom-bar-toggle"
        className={cn(
          "pointer-events-auto absolute bottom-0 right-1 z-30 flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground/40 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:text-foreground",
          !collapsed && "bottom-1.5"
        )}
      >
        {collapsed ? (
          <ChevronUp className="h-3.5 w-3.5" />
        ) : (
          <ChevronDown className="h-4 w-4" />
        )}
      </button>
    </>
  );
}
