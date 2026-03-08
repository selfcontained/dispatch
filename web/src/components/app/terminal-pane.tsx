import { type RefObject, useEffect, useState } from "react";
import { Loader2, TerminalSquare } from "lucide-react";

import { type ConnState } from "@/components/app/types";
import { cn } from "@/lib/utils";

type TerminalPaneProps = {
  isAttached: boolean;
  hasSelectedAgent: boolean;
  connState: ConnState;
  statusMessage: string;
  terminalHostRef: RefObject<HTMLDivElement>;
};

export function TerminalPane({
  isAttached,
  hasSelectedAgent,
  connState,
  statusMessage,
  terminalHostRef
}: TerminalPaneProps): JSX.Element {
  const [showReconnectOverlay, setShowReconnectOverlay] = useState(false);

  useEffect(() => {
    if (connState !== "reconnecting") {
      setShowReconnectOverlay(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setShowReconnectOverlay(true);
    }, 180);

    return () => window.clearTimeout(timer);
  }, [connState]);

  const showEmptyState = !isAttached && !showReconnectOverlay && !hasSelectedAgent;

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-[#141414]">
      <div
        className={cn(
          "h-full w-full",
          !isAttached && connState !== "reconnecting" && "invisible",
          showReconnectOverlay && "blur-[1.5px]"
        )}
      >
        <div className="h-full" ref={terminalHostRef} />
      </div>

      {showEmptyState ? (
        <div className="absolute inset-0 z-20 grid place-items-center bg-[#141414]">
          <div className="flex max-w-md flex-col items-center gap-2 px-6 text-center text-muted-foreground">
            <TerminalSquare className="h-8 w-8" />
            <p className="text-sm">Select an agent and press Play to start and attach to a session.</p>
          </div>
        </div>
      ) : null}

      {showReconnectOverlay ? (
        <div className="absolute inset-0 z-30 grid place-items-center bg-black/70 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 text-sm text-amber-200">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>{statusMessage}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
