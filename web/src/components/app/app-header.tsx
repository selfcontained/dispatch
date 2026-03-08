import { ChevronRight, Image as ImageIcon, Pause } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type AppHeaderProps = {
  leftOpen: boolean;
  mediaOpen: boolean;
  showHeaderStatus: boolean;
  statusText: string;
  headerStatusBorderClass: string;
  isAttached: boolean;
  unseenMediaCount: number;
  setLeftOpen: (open: boolean) => void;
  setMediaOpen: (open: boolean) => void;
  detachTerminal: () => void;
};

export function AppHeader({
  leftOpen,
  mediaOpen,
  showHeaderStatus,
  statusText,
  headerStatusBorderClass,
  isAttached,
  unseenMediaCount,
  setLeftOpen,
  setMediaOpen,
  detachTerminal
}: AppHeaderProps): JSX.Element {
  return (
    <header className={cn("flex h-14 items-center border-b-2 bg-[#11120f] px-3", headerStatusBorderClass)}>
      <div className="flex min-w-0 items-center gap-2">
        {!leftOpen ? (
          <Button size="icon" variant="ghost" onClick={() => setLeftOpen(true)} title="Open agent sidebar">
            <ChevronRight className="h-4 w-4" />
          </Button>
        ) : null}
        {showHeaderStatus ? <span className="truncate text-sm">{statusText}</span> : null}
      </div>

      <div className="ml-auto flex items-center gap-2">
        {isAttached ? (
          <Button size="sm" variant="ghost" onClick={detachTerminal}>
            <Pause className="mr-1 h-3.5 w-3.5" /> Pause
          </Button>
        ) : null}

        {!mediaOpen ? (
          <Button
            size="icon"
            variant="ghost"
            className="relative"
            onClick={() => setMediaOpen(true)}
            title="Open media sidebar"
          >
            <ImageIcon className="h-4 w-4" />
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
