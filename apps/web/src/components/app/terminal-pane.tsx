import { memo, type RefObject, useEffect, useState } from "react";
import { Archive, Loader2, TerminalSquare } from "lucide-react";

import { type Agent, type ConnState } from "@/components/app/types";
import { cn } from "@/lib/utils";

type TerminalPaneProps = {
  isAttached: boolean;
  connState: ConnState;
  statusMessage: string;
  terminalMode: "tmux" | "inert" | null;
  terminalPlaceholderMessage: string | null;
  terminalHostRef: RefObject<HTMLDivElement>;
  archivePhase: Agent["archivePhase"];
};

export const TerminalPane = memo(function TerminalPane({
  isAttached,
  connState,
  statusMessage,
  terminalMode,
  terminalPlaceholderMessage,
  terminalHostRef,
  archivePhase
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

  const showEmptyState = connState === "disconnected" && !isAttached;
  const showInertState = terminalMode === "inert" && isAttached;

  return (
    <div data-testid="terminal-pane" className="relative h-full min-h-0 overflow-hidden bg-terminal-bg touch-none">
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
        <div data-testid="terminal-empty-state" className="absolute inset-0 z-20 grid place-items-center bg-terminal-bg">
          <div className="flex max-w-md flex-col items-center gap-2 px-6 text-center text-muted-foreground">
            <TerminalSquare className="h-8 w-8" />
            <p className="text-sm">Tap an agent row to focus it.</p>
          </div>
        </div>
      ) : null}

      {showInertState ? (
        <div data-testid="terminal-inert-state" className="absolute inset-0 z-20 grid place-items-center bg-terminal-bg">
          <div className="flex max-w-xl flex-col items-center gap-3 px-6 text-center text-muted-foreground">
            <TerminalSquare className="h-9 w-9 text-status-waiting" />
            <p className="text-base font-medium text-foreground">Agent running in inert mode</p>
            <p className="text-sm leading-6 text-muted-foreground">
              {terminalPlaceholderMessage ??
                "This environment does not launch a real tmux session or CLI process. Agent lifecycle flows are simulated for UI validation."}
            </p>
          </div>
        </div>
      ) : null}

      {archivePhase ? (
        <div data-testid="terminal-archive-state" className="absolute inset-0 z-20 grid place-items-center bg-terminal-bg">
          <div className="flex max-w-md flex-col items-center gap-3 px-6 text-center text-muted-foreground">
            <Archive className="h-9 w-9 text-orange-400" />
            <p className="text-base font-medium text-foreground">Archiving agent</p>
            <div className="flex items-center gap-2 text-sm text-orange-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>
                {archivePhase === "stopping" ? "Stopping agent…" :
                 archivePhase === "worktree-check" ? "Checking worktree…" :
                 archivePhase === "worktree-cleanup" ? "Removing worktree…" :
                 archivePhase === "finalizing" ? "Finalizing…" : "Archiving…"}
              </span>
            </div>
            <p className="text-xs text-muted-foreground/70">You can switch to another agent while this completes.</p>
          </div>
        </div>
      ) : null}

      {showReconnectOverlay ? (
        <div className="absolute inset-0 z-30 grid place-items-center bg-black/70 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 text-sm text-status-waiting">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>{statusMessage}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
});
