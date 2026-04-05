import { PanelLeftOpen, PanelRightOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useIconColor } from "@/hooks/use-icon-color";
import { cn } from "@/lib/utils";

type AppHeaderProps = {
  leftOpen: boolean;
  mediaOpen: boolean;
  isMobile: boolean;
  showReconnectIndicator: boolean;
  hasActiveAgent: boolean;
  unseenMediaCount: number;
  setLeftOpen: (open: boolean) => void;
  setMediaOpen: (open: boolean) => void;
};

export function AppHeader({
  leftOpen,
  mediaOpen,
  isMobile,
  showReconnectIndicator,
  hasActiveAgent,
  unseenMediaCount,
  setLeftOpen,
  setMediaOpen,
}: AppHeaderProps): JSX.Element {
  const { iconColor } = useIconColor();
  const showLeftToggle = isMobile ? !leftOpen : !leftOpen;
  const showMediaToggle = hasActiveAgent && (!mediaOpen || isMobile);

  return (
    <header
      data-testid="app-header"
      className={cn(
        "relative flex min-h-14 min-w-0 items-center gap-2 border-b-2 border-b-border bg-surface px-3 py-2 pt-[env(safe-area-inset-top)]"
      )}
    >
      <div className="flex min-w-0 flex-1 items-center">
        {showLeftToggle ? (
          <div
            className={cn(
              "inline-flex items-center gap-1"
            )}
          >
            <Button size="icon" variant="ghost" onClick={() => setLeftOpen(true)} title="Open agent sidebar">
              <PanelRightOpen className="h-4 w-4" />
            </Button>
            {!isMobile ? (
              <img
                src={`/icons/${iconColor}/brand-icon.svg`}
                alt="Dispatch logo"
                className="h-6 w-auto object-contain"
              />
            ) : null}
          </div>
        ) : <div />}
      </div>

      <div className="ml-3 flex shrink-0 items-center gap-1">
        {showMediaToggle ? (
          <Button
            size="icon"
            variant="ghost"
            className="relative"
            onClick={() => setMediaOpen(true)}
            title="Open media sidebar"
            data-testid="toggle-media-sidebar"
          >
            <PanelLeftOpen className="h-4 w-4" />
            {unseenMediaCount > 0 ? (
              <span className="absolute -right-1.5 -top-1.5 min-w-5 rounded-full border border-border bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                {unseenMediaCount}
              </span>
            ) : null}
          </Button>
        ) : null}
      </div>

      {showReconnectIndicator ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
          <div className="dispatch-reconnect-scan h-full w-1/3 bg-gradient-to-r from-transparent via-status-waiting to-transparent" />
        </div>
      ) : null}
    </header>
  );
}
