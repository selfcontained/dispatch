import { PanelLeftOpen, PanelRightOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useIconColor } from "@/hooks/use-icon-color";
import { cn } from "@/lib/utils";

type AppHeaderProps = {
  leftOpen: boolean;
  mediaOpen: boolean;
  isMobile: boolean;
  showHeaderStatus: boolean;
  statusText: string;
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
  showHeaderStatus,
  statusText,
  showReconnectIndicator,
  hasActiveAgent,
  unseenMediaCount,
  setLeftOpen,
  setMediaOpen,
}: AppHeaderProps): JSX.Element {
  const { iconColor } = useIconColor();

  return (
    <header
      data-testid="app-header"
      className={cn(
        "relative flex min-h-14 min-w-0 items-center gap-2 border-b-2 border-b-border bg-surface px-3 py-2 pt-[env(safe-area-inset-top)]"
      )}
    >
      <div
        className={cn(
          "flex items-center overflow-hidden transition-[max-width,opacity,transform] duration-300 ease-out",
          isMobile ? "shrink-0" : leftOpen ? "max-w-0 shrink opacity-0" : "max-w-24 shrink-0 opacity-100"
        )}
        aria-hidden={!isMobile && leftOpen}
      >
        {isMobile ? (
          !leftOpen ? (
            <Button size="icon" variant="ghost" onClick={() => setLeftOpen(true)} title="Open agent sidebar">
              <PanelRightOpen className="h-4 w-4" />
            </Button>
          ) : null
        ) : (
          <div
            className={cn(
              "flex items-center gap-1 transition-[opacity,transform] duration-300 ease-out",
              leftOpen
                ? "pointer-events-none -translate-x-3 opacity-0"
                : "translate-x-0 opacity-100 delay-150"
            )}
          >
            <Button size="icon" variant="ghost" onClick={() => setLeftOpen(true)} title="Open agent sidebar">
              <PanelRightOpen className="h-4 w-4" />
            </Button>
            <img
              src={`/icons/${iconColor}/brand-icon.svg`}
              alt="Dispatch logo"
              className="h-6 w-auto object-contain"
            />
          </div>
        )}
      </div>

      {showHeaderStatus ? (
        <div className="min-w-0 flex-1 overflow-hidden px-1">
          <span
            data-testid="app-header-status"
            title={statusText}
            className="block overflow-hidden text-[11px] leading-tight text-ellipsis sm:text-xs"
            style={{
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: 2
            }}
          >
            {statusText}
          </span>
        </div>
      ) : (
        <div className="flex-1" />
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {hasActiveAgent && (!mediaOpen || isMobile) ? (
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
