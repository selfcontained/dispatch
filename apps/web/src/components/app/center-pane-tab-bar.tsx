import { memo, useCallback, useEffect, useRef } from "react";

import { TipSpot } from "@/components/tips/tip-spot";
import { CENTER_PANE_ID, CENTER_TABS, type CenterTab } from "@/lib/center-tabs";
import { type SplitPaneState } from "@/lib/store";
import { cn } from "@/lib/utils";
import { CountBubble } from "@/components/ui/count-bubble";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const TAB_DRAG_MIME = "application/x-dispatch-tab";

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
  isSplit: boolean;
  splitState: SplitPaneState;
  isMobile: boolean;
  chatUnreadCount?: number;
};

export const CenterPaneTabBar = memo(function CenterPaneTabBar({
  activeTab,
  onTabChange,
  isSplit,
  splitState,
  isMobile,
  chatUnreadCount = 0,
}: CenterPaneTabBarProps): JSX.Element {
  const splitTabs = isSplit
    ? new Set<CenterTab>([splitState.left, splitState.right])
    : new Set<CenterTab>();

  const visibleTabs = CENTER_TABS.filter((t) => !splitTabs.has(t.id));

  // When the strip scrolls (phones), keep the active tab in view: a deep
  // link to Changes would otherwise land with its tab off the right edge.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isMobile) return;
    const active = listRef.current?.querySelector<HTMLElement>(
      '[role="tab"][aria-selected="true"]'
    );
    active?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [activeTab, isMobile]);

  const handleDragStart = useCallback(
    (e: React.DragEvent, tabId: CenterTab) => {
      e.dataTransfer.setData(TAB_DRAG_MIME, tabId);
      e.dataTransfer.effectAllowed = "move";
    },
    []
  );

  if (visibleTabs.length === 0) return <div />;

  return (
    // Click selects, so there is no onValueChange: Radix would select on
    // mousedown, and a tab has to still be inactive to start a drag to split.
    <Tabs
      // While split, the panes on screen are not the tab that was active.
      value={isSplit ? "" : activeTab}
      className="pointer-events-auto min-w-0 max-w-full"
    >
      <TabsList ref={listRef} aria-label="Agent panes">
        {visibleTabs.map((tab) => {
          // Unread chat replies sit on the Agent tab while another tab is up;
          // with the Agent tab active the feed itself is being read.
          const showChatUnread =
            tab.id === "agent" && activeTab !== "agent" && chatUnreadCount > 0;
          const trigger = (
            <TabsTrigger
              key={tab.id}
              value={tab.id}
              aria-controls={isSplit ? undefined : CENTER_PANE_ID}
              data-testid={`center-tab-${tab.id}`}
              draggable={!isMobile && activeTab !== tab.id}
              onDragStart={(e) => handleDragStart(e, tab.id)}
              className={cn(
                // Phones fit all three tabs between two sets of 44px buttons.
                isMobile &&
                  "min-w-11 px-1.5 text-body-sm after:inset-x-1.5 max-sm:px-1",
                activeTab !== tab.id &&
                  !isMobile &&
                  "cursor-grab active:cursor-grabbing"
              )}
              onClick={() => onTabChange(tab.id)}
            >
              <span className="relative">
                {tab.label}
                {showChatUnread ? (
                  <CountBubble
                    tone="info"
                    count={chatUnreadCount}
                    data-testid="chat-unread-count"
                    aria-label={`${chatUnreadCount} unread chat messages`}
                    className="absolute -right-3.5 -top-1.5"
                  />
                ) : null}
              </span>
            </TabsTrigger>
          );

          if (tab.id === "changes" && !isMobile)
            return (
              // Always wrapped: adding or dropping the wrapper on selection
              // would remount the tab and lose the keyboard's focus.
              <TipSpot
                key={tab.id}
                tipId="split-tabs"
                paused={activeTab === tab.id || isSplit}
                side="bottom"
                align="center"
              >
                {trigger}
              </TipSpot>
            );

          return trigger;
        })}
      </TabsList>
    </Tabs>
  );
});
