import { PanelLeftOpen, PanelRightOpen } from "lucide-react";

import {
  CenterPaneTabBar,
  formatDiffCount,
} from "@/components/app/center-pane-tab-bar";
import { ChangesSettingsPopover } from "@/components/app/changes-settings-popover";
import { QuickPhrasesButton } from "@/components/app/quick-phrases";
import { type ConnState, type DiffStats } from "@/components/app/types";
import { TipSpot } from "@/components/tips/tip-spot";
import { Button } from "@/components/ui/button";
import { type CenterTab, type SplitPaneState } from "@/lib/store";

type AgentsViewHeaderProps = {
  isMobile: boolean;
  connState: ConnState;
  leftPanelOpen: boolean;
  handleSetLeftPanelOpen: (open: boolean) => void;
  focusedAgentId: string | null;
  focusedAgentName: string | null;
  hasActiveAgent: boolean;
  focusTerminal: () => void;
  focusedDiffStats: DiffStats | null | undefined;
  changesMatch: boolean;
  whiteboardMatch: boolean;
  isSplit: boolean;
  splitState: SplitPaneState;
  exitSplit: () => void;
  onTabChange: (tab: CenterTab) => void;
  whiteboardAgentDrew: boolean;
  mediaPanelOpen: boolean;
  setMediaOpen: (open: boolean) => void;
  unseenMediaCount: number;
  unreadMessageCount: number;
  unseenSurfaceCount: number;
};

export function AgentsViewHeader({
  isMobile,
  connState,
  leftPanelOpen,
  handleSetLeftPanelOpen,
  focusedAgentId,
  focusedAgentName,
  hasActiveAgent,
  focusTerminal,
  focusedDiffStats,
  changesMatch,
  whiteboardMatch,
  isSplit,
  splitState,
  exitSplit,
  onTabChange,
  whiteboardAgentDrew,
  mediaPanelOpen,
  setMediaOpen,
  unseenMediaCount,
  unreadMessageCount,
  unseenSurfaceCount,
}: AgentsViewHeaderProps): JSX.Element {
  return (
    <div className="relative z-10 grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center bg-background px-3">
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
            agentId={
              hasActiveAgent && connState === "connected"
                ? focusedAgentId!
                : null
            }
            focusTerminal={focusTerminal}
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
      <div className="flex items-center justify-center">
        {focusedAgentName ? (
          <>
            <span data-testid="current-session-name" className="sr-only">
              {focusedAgentName}
            </span>
            <CenterPaneTabBar
              activeTab={
                changesMatch
                  ? "changes"
                  : whiteboardMatch
                    ? "whiteboard"
                    : "terminal"
              }
              onTabChange={(tab) => {
                if (isSplit) {
                  exitSplit();
                }
                onTabChange(tab);
              }}
              whiteboardAgentDrew={whiteboardAgentDrew}
              isSplit={isSplit}
              splitState={splitState}
              isMobile={isMobile}
            />
          </>
        ) : null}
      </div>
      <div className="flex items-center justify-end gap-1">
        {changesMatch && !isSplit ? (
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
            {unseenMediaCount + unreadMessageCount + unseenSurfaceCount > 0 ? (
              <span className="absolute -right-1.5 -top-1.5 min-w-5 rounded-full border border-border bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                {unseenMediaCount + unreadMessageCount + unseenSurfaceCount}
              </span>
            ) : null}
          </Button>
        ) : null}
      </div>
      {connState === "reconnecting" ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
          <div className="dispatch-reconnect-scan h-full w-1/3 will-change-transform bg-[linear-gradient(to_right,transparent,hsl(var(--status-blocked)),hsl(var(--status-waiting)),hsl(var(--status-working)),hsl(var(--status-done)),transparent)] saturate-[1.35] brightness-[1.05] animate-[reconnect-scan_1350ms_ease-in-out_infinite] motion-reduce:animate-none motion-reduce:translate-x-[140%]" />
        </div>
      ) : null}
    </div>
  );
}
