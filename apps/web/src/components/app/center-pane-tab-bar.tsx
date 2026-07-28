import { memo, useCallback } from "react";

import { TipSpot } from "@/components/tips/tip-spot";
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
  { id: "whiteboard", label: "Whiteboard" },
];

const compactDiffCountFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumSignificantDigits: 2,
});

export function formatDiffCount(count: number): string {
  return compactDiffCountFormatter.format(count).toLowerCase();
}

type CenterPaneTabBarProps = {
  activeTab: CenterTab;
  onTabChange: (tab: CenterTab) => void;
  whiteboardAgentDrew?: boolean;
  isSplit: boolean;
  splitState: SplitPaneState;
  isMobile: boolean;
};

export const CenterPaneTabBar = memo(function CenterPaneTabBar({
  activeTab,
  onTabChange,
  whiteboardAgentDrew = false,
  isSplit,
  splitState,
  isMobile,
}: CenterPaneTabBarProps): JSX.Element {
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
      {visibleTabs.map((tab) => {
        const button = (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            data-testid={`center-tab-${tab.id}`}
            draggable={!isMobile && activeTab !== tab.id}
            onDragStart={(e) => handleDragStart(e, tab.id)}
            className={cn(
              "relative flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors",
              activeTab === tab.id
                ? "text-foreground"
                : "cursor-grab text-muted-foreground hover:text-foreground/80 active:cursor-grabbing"
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
              {tab.id === "whiteboard" &&
              whiteboardAgentDrew &&
              activeTab !== "whiteboard" ? (
                <span
                  data-testid="whiteboard-agent-drew-dot"
                  className="absolute -right-2 -top-0.5 h-1.5 w-1.5 rounded-full bg-violet-500"
                />
              ) : null}
              {activeTab === tab.id && !isSplit ? (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-foreground" />
              ) : null}
            </span>
          </button>
        );

        if (
          tab.id === "changes" &&
          activeTab !== tab.id &&
          !isMobile &&
          !isSplit
        )
          return (
            <TipSpot
              key={tab.id}
              tipId="split-tabs"
              side="bottom"
              align="center"
            >
              {button}
            </TipSpot>
          );

        if (
          tab.id === "whiteboard" &&
          activeTab !== tab.id &&
          !isMobile &&
          !isSplit
        )
          return (
            <TipSpot
              key={tab.id}
              tipId="whiteboard"
              side="bottom"
              align="center"
            >
              {button}
            </TipSpot>
          );

        return button;
      })}
    </div>
  );
});
