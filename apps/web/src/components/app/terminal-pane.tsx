import {
  memo,
  type MutableRefObject,
  type RefCallback,
  useEffect,
  useState,
} from "react";
import { Archive, TerminalSquare, Upload } from "lucide-react";

import { type Agent, type ConnState } from "@/components/app/types";
import { TerminalInjectionHoldPill } from "@/components/app/terminal-injection-hold-pill";
import { ActivityBars } from "@/components/ui/activity-bars";
import { cn } from "@/lib/utils";

type TerminalPaneProps = {
  isAttached: boolean;
  connState: ConnState;
  statusMessage: string;
  terminalMode: "tmux" | "inert" | null;
  terminalPlaceholderMessage: string | null;
  terminalHostRef: RefCallback<HTMLDivElement>;
  archivePhase: Agent["archivePhase"];
  resyncing: boolean;
  draggingFiles: boolean;
  uploadingFiles: boolean;
  holdBadgeAgentId: string | null;
  terminalInputAtRef: MutableRefObject<number>;
};

export const TerminalPane = memo(function TerminalPane({
  isAttached,
  connState,
  statusMessage,
  terminalMode,
  terminalPlaceholderMessage,
  terminalHostRef,
  archivePhase,
  resyncing,
  draggingFiles,
  uploadingFiles,
  holdBadgeAgentId,
  terminalInputAtRef,
}: TerminalPaneProps): JSX.Element {
  const [showReconnectOverlay, setShowReconnectOverlay] = useState(false);

  useEffect(() => {
    if (connState !== "reconnecting" || resyncing) {
      setShowReconnectOverlay(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setShowReconnectOverlay(true);
    }, 180);

    return () => window.clearTimeout(timer);
  }, [connState, resyncing]);

  const showEmptyState =
    connState === "disconnected" && !isAttached && !resyncing;
  const showInertState = terminalMode === "inert" && isAttached;

  return (
    <div
      data-testid="terminal-pane"
      className={cn("relative h-full min-h-0 overflow-hidden bg-background")}
    >
      {isAttached && connState === "connected" ? (
        <div data-testid="terminal-connected-state" className="sr-only">
          Connected
        </div>
      ) : null}

      <div
        className={cn(
          "h-full w-full",
          (!isAttached || showInertState) &&
            connState !== "reconnecting" &&
            "invisible",
          showReconnectOverlay && "blur-[1.5px]"
        )}
      >
        <div className="h-full px-2" ref={terminalHostRef} />
      </div>

      {/* Injection hold badge lives inside the pane so it always travels
          with the terminal (portaled into split panes and hidden with the
          pane on the changes/whiteboard routes). */}
      <div className="pointer-events-none absolute bottom-9 right-3 z-30">
        <TerminalInjectionHoldPill
          agentId={holdBadgeAgentId}
          terminalInputAtRef={terminalInputAtRef}
        />
      </div>

      {showEmptyState ? (
        <div
          data-testid="terminal-empty-state"
          className="absolute inset-0 z-20 grid place-items-center bg-background"
        >
          <div className="flex max-w-md flex-col items-center gap-2 px-6 text-center text-muted-foreground">
            <TerminalSquare className="h-8 w-8" />
            <p className="text-sm">Tap an agent row to focus it.</p>
          </div>
        </div>
      ) : null}

      {showInertState ? (
        <div
          data-testid="terminal-inert-state"
          className="absolute inset-0 z-20 grid place-items-center bg-background"
        >
          <div className="flex max-w-xl flex-col items-center gap-3 px-6 text-center text-muted-foreground">
            <TerminalSquare className="h-9 w-9 text-status-waiting" />
            <p className="text-base font-medium text-foreground">
              Agent running in inert mode
            </p>
            <p className="text-sm leading-6 text-muted-foreground">
              {terminalPlaceholderMessage ??
                "This environment does not launch a real tmux session or CLI process. Agent lifecycle flows are simulated for UI validation."}
            </p>
          </div>
        </div>
      ) : null}

      {archivePhase ? (
        <div
          data-testid="terminal-archive-state"
          className="absolute inset-0 z-20 grid place-items-center bg-background"
        >
          <div className="flex max-w-md flex-col items-center gap-3 px-6 text-center text-muted-foreground">
            <Archive className="h-9 w-9 text-orange-400" />
            <p className="text-base font-medium text-foreground">
              Archiving agent
            </p>
            <div className="flex items-center gap-2 text-sm text-orange-400">
              <ActivityBars size={16} />
              <span>
                {archivePhase === "stopping"
                  ? "Stopping agent…"
                  : archivePhase === "worktree-check"
                    ? "Checking worktree…"
                    : archivePhase === "worktree-cleanup"
                      ? "Removing worktree…"
                      : archivePhase === "finalizing"
                        ? "Finalizing…"
                        : "Archiving…"}
              </span>
            </div>
            <p className="text-xs text-muted-foreground/70">
              You can switch to another agent while this completes.
            </p>
          </div>
        </div>
      ) : null}

      {showReconnectOverlay ? (
        <div className="absolute inset-0 z-30 grid place-items-center bg-background/80 backdrop-blur-sm">
          <div className="flex max-w-md flex-col items-center gap-2 px-6 text-center text-sm text-foreground">
            <ActivityBars size={28} />
            <span>{statusMessage}</span>
          </div>
        </div>
      ) : null}

      {draggingFiles ? (
        <div
          data-testid="terminal-drop-overlay"
          className="pointer-events-none absolute inset-0 z-40 m-2 overflow-hidden rounded-xl bg-[linear-gradient(to_right,hsl(var(--status-blocked)),hsl(var(--status-waiting)),hsl(var(--status-working)),hsl(var(--status-done)))] p-[2px] saturate-[1.35] brightness-[1.05]"
        >
          <div className="relative grid h-full w-full place-items-center overflow-hidden rounded-[10px] bg-background/85 backdrop-blur-sm">
            {/* Shiny scan sweep — same status gradient + keyframes as the
                reconnect overlay and ActivityBars. */}
            <div className="dispatch-reconnect-scan pointer-events-none absolute inset-y-0 left-0 w-1/3 animate-[reconnect-scan_1350ms_ease-in-out_infinite] bg-[linear-gradient(to_right,transparent,hsl(var(--status-working)),transparent)] opacity-25 will-change-transform motion-reduce:hidden" />
            <div className="relative flex flex-col items-center gap-2 px-6 text-center text-foreground">
              <Upload className="h-8 w-8" />
              <p className="text-sm font-medium">Drop files to upload</p>
              <p className="text-xs text-muted-foreground">
                Files are uploaded and added to the prompt as [File&nbsp;#1].
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {uploadingFiles ? <UploadingOverlay /> : null}

      <div
        data-testid="terminal-resyncing-state"
        aria-hidden={!resyncing}
        className={cn(
          "pointer-events-none absolute inset-0 z-30 bg-background transition-opacity",
          resyncing ? "opacity-100 duration-75" : "opacity-0 duration-300"
        )}
      />
    </div>
  );
});

function UploadingOverlay() {
  useEffect(() => {
    console.log("[dispatch:uploading-overlay] mounted");
  }, []);

  return (
    <div
      data-testid="terminal-uploading-overlay"
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-x-0 bottom-3 z-40 flex justify-center"
    >
      <div className="flex items-center gap-2 rounded-full border border-border/60 bg-background/90 px-3 py-1.5 text-xs font-medium text-foreground shadow-md backdrop-blur-sm">
        <ActivityBars size={16} />
        <span>Uploading…</span>
      </div>
    </div>
  );
}
