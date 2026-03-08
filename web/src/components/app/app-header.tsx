import { Monitor, MonitorOff, PanelLeftOpen, PanelRightOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type AppHeaderProps = {
  leftOpen: boolean;
  mediaOpen: boolean;
  isMobile: boolean;
  showHeaderStatus: boolean;
  statusText: string;
  headerStatusBorderClass: string;
  isAttached: boolean;
  canAttachSelected: boolean;
  unseenMediaCount: number;
  setLeftOpen: (open: boolean) => void;
  setMediaOpen: (open: boolean) => void;
  attachSelectedAgent: () => void;
  detachTerminal: () => void;
};

export function AppHeader({
  leftOpen,
  mediaOpen,
  isMobile,
  showHeaderStatus,
  statusText,
  headerStatusBorderClass,
  isAttached,
  canAttachSelected,
  unseenMediaCount,
  setLeftOpen,
  setMediaOpen,
  attachSelectedAgent,
  detachTerminal
}: AppHeaderProps): JSX.Element {
  return (
    <header
      className={cn(
        "flex h-14 items-center border-b-2 bg-[#11120f] px-3 pt-[env(safe-area-inset-top)]",
        headerStatusBorderClass
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {(!leftOpen || isMobile) ? (
          <>
            <Button size="icon" variant="ghost" onClick={() => setLeftOpen(true)} title="Open agent sidebar">
              <PanelRightOpen className="h-4 w-4" />
            </Button>
            {!isMobile ? <img src="/brand-icon.svg" alt="Dispatch logo" className="h-6 w-auto object-contain" /> : null}
          </>
        ) : null}
        {showHeaderStatus ? <span className="truncate text-xs sm:text-sm">{statusText}</span> : null}
      </div>

      <div className="ml-auto flex items-center gap-1 sm:gap-2">
        {isAttached ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-sky-300 hover:bg-sky-500/15 hover:text-sky-200"
            onClick={detachTerminal}
            title="Detach from session"
          >
            <MonitorOff className="mr-1 h-3.5 w-3.5" />
            <span className="hidden sm:inline">Detach</span>
          </Button>
        ) : canAttachSelected ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-emerald-300 hover:bg-emerald-500/15 hover:text-emerald-200"
            onClick={attachSelectedAgent}
            title="Attach to session"
          >
            <Monitor className="mr-1 h-3.5 w-3.5" />
            <span className="hidden sm:inline">Attach</span>
          </Button>
        ) : null}

        {(!mediaOpen || isMobile) ? (
          <Button
            size="icon"
            variant="ghost"
            className="relative"
            onClick={() => setMediaOpen(true)}
            title="Open media sidebar"
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
    </header>
  );
}
