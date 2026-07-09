import { memo, useCallback } from "react";

import type { DiffStats } from "@/components/app/types";
import { type CenterTab, type SplitPaneState } from "@/lib/store";
import { cn } from "@/lib/utils";

export const TAB_DRAG_MIME = "application/x-dispatch-tab";

type TabDef = {
  id: CenterTab;
  label: string;
};

const TABS: TabDef[] = [
  { id: "terminal", label: "Terminal" },
  { id: "changes", label: "Changes" },
];

type CenterPaneTabBarProps = {
  activeTab: CenterTab;
  onTabChange: (tab: CenterTab) => void;
  diffStats: DiffStats | null | undefined;
  isSplit: boolean;
  splitState: SplitPaneState;
  isMobile: boolean;
};

export const CenterPaneTabBar = memo(function CenterPaneTabBar({
  activeTab,
  onTabChange,
  diffStats,
  isSplit,
  splitState,
  isMobile,
}: CenterPaneTabBarProps): JSX.Element {
  const hasChanges =
    diffStats && (diffStats.added > 0 || diffStats.deleted > 0);

  const splitTabs = isSplit
    ? new Set<CenterTab>([splitState.left, splitState.right])
    : new Set<CenterTab>();

  const visibleTabs = TABS.filter((t) => !splitTabs.has(t.id));

  const handleDragStart = useCallback(
    (e: React.DragEvent, tabId: CenterTab) => {
      e.dataTransfer.setData(TAB_DRAG_MIME, tabId);
      e.dataTransfer.effectAllowed = "move";
    },
    []
  );

  if (visibleTabs.length === 0) return <div />;

  return (
    <div role="tablist" className="pointer-events-auto flex items-center">
      {visibleTabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={activeTab === tab.id}
          data-testid={`center-tab-${tab.id}`}
          draggable={!isMobile}
          onDragStart={(e) => handleDragStart(e, tab.id)}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors cursor-grab active:cursor-grabbing",
            activeTab === tab.id
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground/80"
          )}
          onClick={() => {
            if (isSplit) {
              // Clicking a tab in center bar while split exits split mode
              // and shows that tab full-width (per spec)
            }
            onTabChange(tab.id);
          }}
        >
          <span className="relative pb-1.5 -mb-1.5">
            {tab.label}
            {activeTab === tab.id && !isSplit ? (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-foreground" />
            ) : null}
          </span>
          {tab.id === "changes" && hasChanges ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/30 px-1.5 py-0 font-mono text-[10px] font-normal normal-case tracking-normal">
              <span className="text-status-working">+{diffStats.added}</span>
              <span className="text-status-blocked">-{diffStats.deleted}</span>
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
});
