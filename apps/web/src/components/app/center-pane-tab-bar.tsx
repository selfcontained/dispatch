import { memo } from "react";

import type { DiffStats } from "@/components/app/types";
import { cn } from "@/lib/utils";

type CenterTab = "terminal" | "changes";

type CenterPaneTabBarProps = {
  activeTab: CenterTab;
  onTabChange: (tab: CenterTab) => void;
  diffStats: DiffStats | null | undefined;
};

export const CenterPaneTabBar = memo(function CenterPaneTabBar({
  activeTab,
  onTabChange,
  diffStats,
}: CenterPaneTabBarProps): JSX.Element {
  const hasChanges =
    diffStats && (diffStats.added > 0 || diffStats.deleted > 0);

  return (
    <div className="pointer-events-auto flex items-center">
      <button
        type="button"
        data-testid="center-tab-terminal"
        className={cn(
          "px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors",
          activeTab === "terminal"
            ? "text-foreground"
            : "text-muted-foreground hover:text-foreground/80"
        )}
        onClick={() => onTabChange("terminal")}
      >
        <span className="relative pb-1.5 -mb-1.5">
          Terminal
          {activeTab === "terminal" ? (
            <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-foreground" />
          ) : null}
        </span>
      </button>
      <button
        type="button"
        data-testid="center-tab-changes"
        className={cn(
          "flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors",
          activeTab === "changes"
            ? "text-foreground"
            : "text-muted-foreground hover:text-foreground/80"
        )}
        onClick={() => onTabChange("changes")}
      >
        <span className="relative pb-1.5 -mb-1.5">
          Changes
          {activeTab === "changes" ? (
            <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-foreground" />
          ) : null}
        </span>
        {hasChanges ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/30 px-1.5 py-0 font-mono text-[10px] font-normal normal-case tracking-normal">
            <span className="text-status-working">+{diffStats.added}</span>
            <span className="text-status-blocked">−{diffStats.deleted}</span>
          </span>
        ) : null}
      </button>
    </div>
  );
});
