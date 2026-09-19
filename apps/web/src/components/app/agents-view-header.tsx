import { PanelLeftOpen, PanelRightOpen } from "lucide-react";

import {
  CenterPaneTabBar,
  formatDiffCount,
} from "@/components/app/center-pane-tab-bar";
import { ChangesSettingsPopover } from "@/components/app/changes-settings-popover";
import { QuickPhrasesButton } from "@/components/app/quick-phrases";
import { type DiffStats } from "@/components/app/types";
import { TipSpot } from "@/components/tips/tip-spot";
import { Button } from "@/components/ui/button";
import { type CenterTab, type SplitPaneState } from "@/lib/store";
import { cn } from "@/lib/utils";

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
  mediaPanelOpen: boolean;
  setMediaOpen: (open: boolean) => void;
  unseenMediaCount: number;
  unseenSurfaceCount: number;
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
  mediaPanelOpen,
  setMediaOpen,
  unseenMediaCount,
  unseenSurfaceCount,
}: AgentsViewHeaderProps): JSX.Element {
  return (
    <div
      className={cn(
        "relative z-10 grid h-14 shrink-0 items-center bg-background px-3",
        // On phones the side columns hug their buttons so the tab strip gets
        // the rest of the width (and scrolls inside it).
        isMobile
          ? "grid-cols-[auto_minmax(0,1fr)_auto] gap-1"
          : "grid-cols-[1fr_auto_1fr]"
      )}
    >
      <div className="flex items-center gap-1">
        {!leftPanelOpen ? (
          <Button
            size="icon"
            variant="ghost"
            onClick={() => handleSetLeftPanelOpen(true)}
            title="Open sidebar"
          >
            <PanelRightOpen className="h-4 w-4" />
          </Button>
        ) : null}
        <TipSpot tipId="quick-phrases" side="bottom" align="center">
          <QuickPhrasesButton
            agentId={hasActiveAgent ? focusedAgentId : null}
          />
        </TipSpot>
        {focusedDiffStats &&
        (focusedDiffStats.added > 0 || focusedDiffStats.deleted > 0) ? (
          <span
            aria-label={`${focusedDiffStats.added.toLocaleString("en-US")} additions, ${focusedDiffStats.deleted.toLocaleString("en-US")} deletions`}
            title={`${focusedDiffStats.added.toLocaleString("en-US")} additions, ${focusedDiffStats.deleted.toLocaleString("en-US")} deletions`}
            className="hidden items-center gap-1 whitespace-nowrap rounded-full border border-border/50 bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] tracking-normal sm:inline-flex"
          >
            <span className="text-status-working">
              +{formatDiffCount(focusedDiffStats.added)}
            </span>
            <span className="text-status-blocked">
              {"−"}
              {formatDiffCount(focusedDiffStats.deleted)}
            </span>
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center justify-center">
        {focusedAgentName ? (
          <>
            <span data-testid="current-session-name" className="sr-only">
              {focusedAgentName}
            </span>
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
        ) : null}
      </div>
      <div className="flex items-center justify-end gap-1">
        {activeTab === "changes" && !isSplit ? (
          <ChangesSettingsPopover isMobile={isMobile} />
        ) : null}
        {hasActiveAgent && (!mediaPanelOpen || isMobile) ? (
          <Button
            size="icon"
            variant="ghost"
            className="relative"
            onClick={() => setMediaOpen(true)}
            title="Open media sidebar"
            data-testid="toggle-media-sidebar"
          >
            <PanelLeftOpen className="h-4 w-4" />
            {unseenMediaCount + unseenSurfaceCount > 0 ? (
              <span className="absolute -right-1.5 -top-1.5 min-w-5 rounded-full border border-border bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                {unseenMediaCount + unseenSurfaceCount}
              </span>
            ) : null}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
