import { Split } from "lucide-react";

import { ChangesSettingsPopover } from "@/components/app/changes-settings-popover";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { type CenterTab, centerTabLabel } from "@/lib/center-tabs";
import { type SplitPaneState } from "@/lib/store";

type CenterPaneSplitProps = {
  splitState: SplitPaneState;
  splitLeftRef: React.RefObject<HTMLDivElement>;
  splitButtonRef: React.RefObject<HTMLButtonElement>;
  splitTerminalSlotRef: React.RefObject<HTMLDivElement>;
  changesElement: React.ReactNode;
  whiteboardElement: React.ReactNode;
  /** The Agent pane (Chat + Console) for the "agent" slot, flag on. */
  agentElement?: React.ReactNode;
  /** The Chat | Console toggle, shown in the "agent" slot's header. */
  agentHeaderAccessory?: React.ReactNode;
  isMobile: boolean;
  onLayoutChange: (layout: Record<string, number>) => void;
  onExitSplit: () => void;
};

/**
 * The split-pane layout for the center pane: two resizable panels, each showing
 * either the terminal (via the shared terminal slot) or the Changes tab, with an
 * unsplit button anchored on the divider. Purely presentational — the terminal
 * DOM node is portaled into `splitTerminalSlotRef` by the parent.
 *
 * The unsplit button straddles the divider, so each header keeps its
 * divider-side padding wider than the button's overhang and its title yields
 * (truncates) before an accessory would be pushed under the button.
 */
export function CenterPaneSplit({
  splitState,
  splitLeftRef,
  splitButtonRef,
  splitTerminalSlotRef,
  changesElement,
  whiteboardElement,
  agentElement = null,
  agentHeaderAccessory = null,
  isMobile,
  onLayoutChange,
  onExitSplit,
}: CenterPaneSplitProps): JSX.Element {
  const paneFor = (tab: CenterTab): React.ReactNode => {
    switch (tab) {
      case "terminal":
        return <div ref={splitTerminalSlotRef} className="h-full" />;
      case "agent":
        return agentElement;
      case "whiteboard":
        return whiteboardElement;
      default:
        return changesElement;
    }
  };
  const accessoryFor = (tab: CenterTab): React.ReactNode => {
    if (tab === "changes" && !isMobile) return <ChangesSettingsPopover />;
    if (tab === "agent") return agentHeaderAccessory;
    return null;
  };

  return (
    <div className="relative h-full">
      <ResizablePanelGroup
        orientation="horizontal"
        onLayoutChanged={onLayoutChange}
        className="h-full"
      >
        <ResizablePanel
          id="split-left"
          defaultSize={splitState.sizes[0]}
          minSize={20}
        >
          <div ref={splitLeftRef} className="flex h-full flex-col">
            <div className="flex min-h-8 shrink-0 items-center justify-between gap-2 border-b border-border/40 py-1.5 pl-3 pr-6">
              <span className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {centerTabLabel(splitState.left)}
              </span>
              {accessoryFor(splitState.left)}
            </div>
            <div className="min-h-0 flex-1">{paneFor(splitState.left)}</div>
          </div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel
          id="split-right"
          defaultSize={splitState.sizes[1]}
          minSize={20}
        >
          <div className="flex h-full flex-col">
            <div className="flex min-h-8 shrink-0 items-center justify-between gap-2 border-b border-border/40 py-1.5 pl-6 pr-3">
              <span className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {centerTabLabel(splitState.right)}
              </span>
              {accessoryFor(splitState.right)}
            </div>
            <div className="min-h-0 flex-1">{paneFor(splitState.right)}</div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      <button
        ref={splitButtonRef}
        type="button"
        onClick={onExitSplit}
        title="Unsplit panes"
        data-testid="unsplit-button"
        className="absolute top-0 z-50 flex h-8 -translate-x-1/2 cursor-pointer items-center justify-center rounded-md border bg-background px-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        style={{ left: `${splitState.sizes[0]}%` }}
      >
        <Split className="h-4 w-4 shrink-0" />
      </button>
    </div>
  );
}
