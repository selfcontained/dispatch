import { memo, useCallback, useEffect, useRef } from "react";

import { TipSpot } from "@/components/tips/tip-spot";
import { formatBadgeCount } from "@/lib/format";
import { type CenterTab, centerTabs } from "@/lib/center-tabs";
import { type SplitPaneState } from "@/lib/store";
import { cn } from "@/lib/utils";

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
  whiteboardAgentDrew?: boolean;
  isSplit: boolean;
  splitState: SplitPaneState;
  isMobile: boolean;
  /** The chat surface as it applies to this agent (see `agentSupportsChat`). */
  chatEnabled: boolean;
  chatUnreadCount?: number;
};

export const CenterPaneTabBar = memo(function CenterPaneTabBar({
  activeTab,
  onTabChange,
  whiteboardAgentDrew = false,
  isSplit,
  splitState,
  isMobile,
  chatEnabled,
  chatUnreadCount = 0,
}: CenterPaneTabBarProps): JSX.Element {
  const splitTabs = isSplit
    ? new Set<CenterTab>([splitState.left, splitState.right])
    : new Set<CenterTab>();

  const visibleTabs = centerTabs(chatEnabled).filter(
    (t) => !splitTabs.has(t.id)
  );

  // When the strip scrolls (phones), keep the active tab in view: a deep
  // link to Whiteboard would otherwise land with its tab off the right edge.
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
    <div
      ref={listRef}
      role="tablist"
      className={cn(
        "pointer-events-auto flex items-center",
        // Four tabs overflow a 320px phone; let the strip scroll instead of
        // clipping, and hide the scrollbar it would otherwise draw.
        isMobile &&
          "max-w-full overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      )}
    >
      {visibleTabs.map((tab) => {
        // Unread chat replies sit on the Agent tab while another tab is up;
        // with the Agent tab active the pane's own Chat | Console toggle
        // carries the count (see AgentViewToggle).
        const showChatUnread =
          tab.id === "agent" && activeTab !== "agent" && chatUnreadCount > 0;
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
              "relative flex shrink-0 items-center gap-1.5 whitespace-nowrap py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors",
              isMobile ? "px-2.5" : "px-3",
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
              {showChatUnread ? (
                <span
                  data-testid="chat-unread-count"
                  aria-label={`${chatUnreadCount} unread chat messages`}
                  className="absolute -right-3.5 -top-1 min-w-4 rounded-full bg-primary px-1 text-center text-[9px] font-semibold leading-4 tracking-normal text-primary-foreground"
                >
                  {formatBadgeCount(chatUnreadCount)}
                </span>
              ) : null}
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
