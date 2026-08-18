import { Split } from "lucide-react";

import { ChangesSettingsPopover } from "@/components/app/changes-settings-popover";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { type CenterTab, type SplitPaneState } from "@/lib/store";

const TAB_LABELS: Record<CenterTab, string> = {
  terminal: "Terminal",
  changes: "Changes",
  whiteboard: "Whiteboard",
};

type CenterPaneSplitProps = {
  splitState: SplitPaneState;
  splitLeftRef: React.RefObject<HTMLDivElement>;
  splitButtonRef: React.RefObject<HTMLButtonElement>;
  splitTerminalSlotRef: React.RefObject<HTMLDivElement>;
  changesElement: React.ReactNode;
  whiteboardElement: React.ReactNode;
  isMobile: boolean;
  onLayoutChange: (layout: Record<string, number>) => void;
  onExitSplit: () => void;
  /** Mirrors the tab bar's override so both surfaces name the pane alike. */
  terminalTabLabel?: string;
};

/**
 * The split-pane layout for the center pane: two resizable panels, each showing
 * either the terminal (via the shared terminal slot) or the Changes tab, with an
 * unsplit button anchored on the divider. Purely presentational — the terminal
 * DOM node is portaled into `splitTerminalSlotRef` by the parent.
 */
export function CenterPaneSplit({
  splitState,
  splitLeftRef,
  splitButtonRef,
  splitTerminalSlotRef,
  changesElement,
  whiteboardElement,
  isMobile,
  onLayoutChange,
  onExitSplit,
  terminalTabLabel,
}: CenterPaneSplitProps): JSX.Element {
  const labelFor = (tab: CenterTab): string =>
    tab === "terminal"
      ? (terminalTabLabel ?? TAB_LABELS.terminal)
      : TAB_LABELS[tab];
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
            <div className="flex h-8 shrink-0 items-center justify-between border-b border-border/40 pl-6 pr-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {labelFor(splitState.left)}
              </span>
              {splitState.left === "changes" && !isMobile ? (
                <ChangesSettingsPopover />
              ) : null}
            </div>
            <div className="min-h-0 flex-1">
              {splitState.left === "terminal" ? (
                <div ref={splitTerminalSlotRef} className="h-full" />
              ) : splitState.left === "whiteboard" ? (
                whiteboardElement
              ) : (
                changesElement
              )}
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel
          id="split-right"
          defaultSize={splitState.sizes[1]}
          minSize={20}
        >
          <div className="flex h-full flex-col">
            <div className="flex h-8 shrink-0 items-center justify-between border-b border-border/40 pl-6 pr-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {labelFor(splitState.right)}
              </span>
              {splitState.right === "changes" && !isMobile ? (
                <ChangesSettingsPopover />
              ) : null}
            </div>
            <div className="min-h-0 flex-1">
              {splitState.right === "terminal" ? (
                <div ref={splitTerminalSlotRef} className="h-full" />
              ) : splitState.right === "whiteboard" ? (
                whiteboardElement
              ) : (
                changesElement
              )}
            </div>
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
