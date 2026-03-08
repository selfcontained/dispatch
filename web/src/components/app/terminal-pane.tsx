import { type RefObject } from "react";
import { Loader2, TerminalSquare } from "lucide-react";

import { type ConnState } from "@/components/app/types";
import { cn } from "@/lib/utils";

type TerminalPaneProps = {
  isAttached: boolean;
  connState: ConnState;
  statusMessage: string;
  terminalHostRef: RefObject<HTMLDivElement>;
};

export function TerminalPane({
  isAttached,
  connState,
  statusMessage,
  terminalHostRef
}: TerminalPaneProps): JSX.Element {
  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-[#141414]">
      <div className={cn("h-full w-full", !isAttached && connState !== "reconnecting" && "invisible")}>
        <div className="h-full" ref={terminalHostRef} />
      </div>

      {!isAttached ? (
        <div className="absolute inset-0 z-20 grid place-items-center bg-[#141414]">
          <div className="flex max-w-md flex-col items-center gap-2 px-6 text-center text-muted-foreground">
            <TerminalSquare className="h-8 w-8" />
            <p className="text-sm">Select an agent and press Play to open a terminal connection.</p>
          </div>
        </div>
      ) : null}

      {connState === "reconnecting" ? (
        <div className="absolute inset-0 z-30 grid place-items-center bg-black/75">
          <div className="flex flex-col items-center gap-2 text-sm text-amber-200">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>{statusMessage}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
