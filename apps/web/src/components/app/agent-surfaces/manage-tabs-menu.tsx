import { useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  MoreHorizontal,
  RotateCcw,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { ManagedSurfaceTab } from "@/components/app/agent-surfaces/use-surface-tab-prefs";

/**
 * Overflow list + compact reorder/hide affordance for custom tabs, combined
 * into one menu. "Move earlier/later" (not "left/right") per naming
 * guidance — this reorders the tab strip, not agent work items.
 *
 * Uses Popover rather than DropdownMenu: each row holds up to four
 * independently-focusable controls (select tab, move earlier, move later,
 * show/hide), and Radix's DropdownMenu enforces single-axis arrow-key
 * roving focus across `menuitem`-role children — it doesn't support
 * multiple interactive elements per row. Popover keeps ordinary Tab/Shift+Tab
 * focus order and focus-trapping, which is the right semantics here.
 */
export function ManageTabsMenu({
  managedTabs,
  activeTabId,
  onSelectTab,
  hiddenCount,
  moveTabEarlier,
  moveTabLater,
  toggleHidden,
  resetOrder,
  isNew,
}: {
  managedTabs: ManagedSurfaceTab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  hiddenCount: number;
  moveTabEarlier: (id: string) => void;
  moveTabLater: (id: string) => void;
  toggleHidden: (id: string) => void;
  resetOrder: () => void;
  /** Surfaces the tab strip's own "unseen" flag here too — a hidden tab has
   * no button in the strip to show it on, so this is the only place a
   * still-unseen hidden tab can be signaled. */
  isNew?: (surfaceId: string) => boolean;
}): JSX.Element {
  // Controlled open state so selecting a surface can close the menu, while
  // reorder/hide/reset (which the user may want to repeat) leave it open.
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="More tabs and tab settings"
          data-testid="surface-tabs-more"
          className="relative flex h-11 shrink-0 items-center gap-1 rounded px-2 text-[11px] font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground md:h-7 [@media(pointer:coarse)]:h-11"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
          {hiddenCount > 0 ? (
            <span className="text-[10px]">{hiddenCount}</span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Manage tabs"
        className="w-64 overflow-hidden p-1.5"
      >
        <div className="max-h-72 space-y-0.5 overflow-y-auto">
          {managedTabs.map(({ surface, hidden }, index) => (
            <div
              key={surface.id}
              data-testid="manage-tab-row"
              data-surface-id={surface.id}
              data-hidden={hidden ? "true" : "false"}
              className={cn(
                "flex items-center gap-1 rounded-sm px-1.5 py-1",
                surface.id === activeTabId && "bg-muted/60"
              )}
            >
              {isNew?.(surface.id) ? (
                <span
                  aria-label="New"
                  data-testid="manage-tab-new-dot"
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                />
              ) : null}
              <button
                type="button"
                onClick={() => {
                  onSelectTab(surface.id);
                  setOpen(false);
                }}
                className={cn(
                  "min-h-11 min-w-0 flex-1 truncate px-1 text-left text-xs md:min-h-0 md:px-0 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-1",
                  hidden ? "text-muted-foreground" : "text-foreground"
                )}
                title={surface.title}
              >
                {surface.title}
              </button>
              {surface.unresolvedInteractionCount > 0 ? (
                <span
                  aria-label={`${surface.unresolvedInteractionCount} pending`}
                  data-testid="manage-tab-unresolved-count"
                  className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-primary text-[8px] text-primary-foreground"
                >
                  {surface.unresolvedInteractionCount}
                </span>
              ) : null}
              <button
                type="button"
                aria-label="Move tab earlier"
                title="Move tab earlier"
                disabled={index === 0}
                onClick={() => moveTabEarlier(surface.id)}
                className="h-11 w-11 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 md:h-7 md:w-7 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label="Move tab later"
                title="Move tab later"
                disabled={index === managedTabs.length - 1}
                onClick={() => moveTabLater(surface.id)}
                className="h-11 w-11 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 md:h-7 md:w-7 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label={hidden ? "Show tab" : "Hide tab"}
                title={hidden ? "Show tab" : "Hide tab"}
                onClick={() => toggleHidden(surface.id)}
                className="h-11 w-11 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground md:h-7 md:w-7 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
              >
                {hidden ? (
                  <EyeOff className="h-3.5 w-3.5" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          ))}
        </div>
        <div className="mt-1 border-t border-border/60 pt-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={resetOrder}
            className="min-h-11 w-full justify-start gap-1.5 text-xs md:min-h-9 [@media(pointer:coarse)]:min-h-11"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset tab order
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
