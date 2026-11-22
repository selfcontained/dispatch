import { PanelLeftOpen } from "lucide-react";

import {
  CenterPaneTabBar,
  formatDiffCount,
} from "@/components/app/center-pane-tab-bar";
import { ChangesSettingsPopover } from "@/components/app/changes-settings-popover";
import { QuickPhrasesButton } from "@/components/app/quick-phrases";
import { type DiffStats } from "@/components/app/types";
import { TipSpot } from "@/components/tips/tip-spot";
import { type CenterTab, type SplitPaneState } from "@/lib/store";
import { SectionChrome } from "@/components/app/section-chrome";
import { PageHeader } from "@/components/ui/page-header";
import { Chip } from "@/components/ui/chip";
import { CountBubble } from "@/components/ui/count-bubble";
import { IconButton } from "@/components/ui/icon-button";
import { Hint } from "@/components/ui/tooltip";

type AgentsViewHeaderProps = {
  isMobile: boolean;
  leftPanelOpen: boolean;
  handleSetLeftPanelOpen: (open: boolean) => void;
  focusedAgentId: string | null;
  focusedAgentName: string | null;
  hasActiveAgent: boolean;
  focusedDiffStats: DiffStats | null | undefined;
  activeTab: CenterTab;
  /**
   * False while a legacy route redirect is pending. The tab bar waits, so it
   * never highlights a tab for a frame before the redirect lands.
   */
  centerTabResolved?: boolean;
  chatUnreadCount?: number;
  isSplit: boolean;
  splitState: SplitPaneState;
  exitSplit: () => void;
  onTabChange: (tab: CenterTab) => void;
  drawerPanelOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  unseenFileCount: number;
  /** Open questions and forms waiting on the user (the Inbox). */
  openInputCount: number;
};

export function AgentsViewHeader({
  isMobile,
  leftPanelOpen,
  handleSetLeftPanelOpen,
  focusedAgentId,
  focusedAgentName,
  hasActiveAgent,
  focusedDiffStats,
  activeTab,
  centerTabResolved = true,
  chatUnreadCount = 0,
  isSplit,
  splitState,
  exitSplit,
  onTabChange,
  drawerPanelOpen,
  setDrawerOpen,
  unseenFileCount,
  openInputCount,
}: AgentsViewHeaderProps): JSX.Element {
  const diffSummary = focusedDiffStats
    ? `${focusedDiffStats.added.toLocaleString("en-US")} additions, ${focusedDiffStats.deleted.toLocaleString("en-US")} deletions`
    : "";
  return (
    <SectionChrome
      leftPanelOpen={leftPanelOpen}
      onOpenSidebar={() => handleSetLeftPanelOpen(true)}
      trailing={
        hasActiveAgent && (!drawerPanelOpen || isMobile) ? (
          <IconButton
            className="relative"
            onClick={() => setDrawerOpen(true)}
            label="Open drawer"
            data-testid="toggle-drawer"
          >
            <PanelLeftOpen />
            {unseenFileCount + openInputCount > 0 ? (
              <CountBubble
                tone="info"
                count={unseenFileCount + openInputCount}
                className="absolute -right-1 -top-1 pointer-coarse:right-0.5 pointer-coarse:top-0.5"
                data-testid="toggle-drawer-badge"
              />
            ) : null}
          </IconButton>
        ) : null
      }
    >
      <PageHeader
        title={
          focusedAgentName ? (
            <span data-testid="current-session-name">{focusedAgentName}</span>
          ) : (
            "Agents"
          )
        }
        start={
          <>
            <TipSpot tipId="quick-phrases" side="bottom" align="center">
              <QuickPhrasesButton
                agentId={hasActiveAgent ? focusedAgentId : null}
              />
            </TipSpot>
            {focusedDiffStats &&
            (focusedDiffStats.added > 0 || focusedDiffStats.deleted > 0) ? (
              <Hint label={diffSummary}>
                <Chip
                  size="sm"
                  role="img"
                  aria-label={diffSummary}
                  className="hidden font-mono sm:inline-flex"
                >
                  <span className="text-success">
                    +{formatDiffCount(focusedDiffStats.added)}
                  </span>
                  <span className="text-danger">
                    {"−"}
                    {formatDiffCount(focusedDiffStats.deleted)}
                  </span>
                </Chip>
              </Hint>
            ) : null}
          </>
        }
        // The session is the title; its tabs sit where it would be.
        center={
          focusedAgentName ? (
            <>
              {centerTabResolved ? (
                <CenterPaneTabBar
                  activeTab={activeTab}
                  onTabChange={(tab) => {
                    if (isSplit) {
                      exitSplit();
                    }
                    onTabChange(tab);
                  }}
                  isSplit={isSplit}
                  splitState={splitState}
                  isMobile={isMobile}
                  chatUnreadCount={chatUnreadCount}
                />
              ) : null}
            </>
          ) : null
        }
        actions={
          activeTab === "changes" && !isSplit ? (
            <ChangesSettingsPopover isMobile={isMobile} />
          ) : null
        }
      />
    </SectionChrome>
  );
}
