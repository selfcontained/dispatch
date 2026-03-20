import { memo, type RefObject, useEffect, useState } from "react";
import { Loader2, TerminalSquare } from "lucide-react";

import { type ConnState } from "@/components/app/types";
import { cn } from "@/lib/utils";

type TerminalPaneProps = {
  isAttached: boolean;
  hasSelectedAgent: boolean;
  connState: ConnState;
  statusMessage: string;
  terminalMode: "tmux" | "inert" | null;
  terminalPlaceholderMessage: string | null;
  terminalHostRef: RefObject<HTMLDivElement>;
};

export const TerminalPane = memo(function TerminalPane({
  isAttached,
  hasSelectedAgent,
  connState,
  statusMessage,
  terminalMode,
  terminalPlaceholderMessage,
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

  const showEmptyState = connState === "disconnected" && !isAttached && !hasSelectedAgent;
  const showInertState = terminalMode === "inert" && isAttached;

  return (
    <div data-testid="terminal-pane" className="relative h-full min-h-0 overflow-hidden bg-[#141414]">
      <div
        className={cn(
          "h-full w-full",
          (!isAttached || showInertState) && connState !== "reconnecting" && "invisible",
          showReconnectOverlay && "blur-[1.5px]"
        )}
      >
        <div className="h-full" ref={terminalHostRef} />
      </div>

      {showEmptyState ? (
        <div data-testid="terminal-empty-state" className="absolute inset-0 z-20 grid place-items-center bg-[#141414]">
          <div className="flex max-w-md flex-col items-center gap-2 px-6 text-center text-muted-foreground">
            <TerminalSquare className="h-8 w-8" />
            <p className="text-sm">Select an agent and press Play to start and attach to a session.</p>
          </div>
        </div>
      ) : null}

      {showInertState ? (
        <div data-testid="terminal-inert-state" className="absolute inset-0 z-20 grid place-items-center bg-[#141414]">
          <div className="flex max-w-xl flex-col items-center gap-3 px-6 text-center text-zinc-300">
            <TerminalSquare className="h-9 w-9 text-amber-300" />
            <p className="text-base font-medium text-zinc-100">Agent running in inert mode</p>
            <p className="text-sm leading-6 text-zinc-400">
              {terminalPlaceholderMessage ??
                "This environment does not launch a real tmux session or CLI process. Agent lifecycle flows are simulated for UI validation."}
            </p>
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
});
