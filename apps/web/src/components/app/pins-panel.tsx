import { Pin } from "lucide-react";
import { useRef, useState } from "react";

import { PinGroup, layoutPins } from "@/components/app/pin-group";
import { PinItem } from "@/components/app/pin-item";
import { type AgentPin } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";

/**
 * The rendering unit for a set of pins: grouping policy and `PinItem` travel
 * together, so every consumer gets group headings without re-implementing the
 * layout. Omit `onRunShortcut` (e.g. agent history) and shortcuts render
 * disabled.
 */
export function PinList({
  pins,
  workspaceRoot,
  agentIsRunning,
  onRunShortcut,
  agentName = null,
  pendingPinId = null,
  buttonRef,
  collapseScope = null,
}: {
  pins: AgentPin[];
  workspaceRoot: string | null;
  agentIsRunning?: boolean;
  onRunShortcut?: (pin: AgentPin, pointerType?: string) => void;
  agentName?: string | null;
  pendingPinId?: string | null;
  buttonRef?: (pin: AgentPin, element: HTMLButtonElement | null) => void;
  /**
   * Namespaces persisted collapse state — an agent id, so it survives a
   * session rename. `null` means don't persist at all: a shared fallback
   * bucket would leak one list's collapse choices onto every other list.
   */
  collapseScope?: string | null;
}): JSX.Element {
  return (
    <>
      {layoutPins(pins).map((row) =>
        row.kind === "pin" ? (
          <PinItem
            key={row.pin.id ?? row.pin.label.toLowerCase()}
            pin={row.pin}
            workspaceRoot={workspaceRoot}
            agentIsRunning={agentIsRunning}
            onRunShortcut={onRunShortcut}
            agentName={agentName}
            pendingPinId={pendingPinId}
            buttonRef={buttonRef}
          />
        ) : (
          <PinGroup
            key={`group:${row.name.toLowerCase()}`}
            name={row.name}
            pins={row.pins}
            collapseScope={collapseScope}
            workspaceRoot={workspaceRoot}
            agentIsRunning={agentIsRunning}
            onRunShortcut={onRunShortcut}
            agentName={agentName}
            pendingPinId={pendingPinId}
            buttonRef={buttonRef}
          />
        )
      )}
    </>
  );
}

type PinsPanelProps = {
  pins: AgentPin[];
  selectedAgentName: string | null;
  selectedAgentWorkspaceRoot: string | null;
  agentIsRunning?: boolean;
  onRunShortcut?: (pin: AgentPin, pointerType?: string) => void;
  pendingPinId?: string | null;
  /** Agent id, so persisted group collapse survives a session rename. Omit to keep collapse ephemeral. */
  collapseScope?: string | null;
};

/**
 * Confirmation is opt-in per shortcut pin (`confirm: true`) — the owning agent
 * decides which of its own actions deserve a second look before firing.
 */
function ConfirmShortcutDialog({
  pin,
  onOpenChange,
  onConfirm,
  onRestoreFocus,
}: {
  pin: AgentPin | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  onRestoreFocus?: () => void;
}): JSX.Element {
  return (
    <Dialog open={pin !== null} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="pin-shortcut-confirm-dialog"
        onCloseAutoFocus={(event) => {
          if (!onRestoreFocus) return;
          event.preventDefault();
          onRestoreFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{pin?.label ?? "Run action"}?</DialogTitle>
          <DialogDescription>
            This sends the following prompt to the agent:
          </DialogDescription>
        </DialogHeader>
        <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-background/40 p-2 font-sans text-xs text-foreground">
          {pin?.value}
        </pre>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={pin?.variant === "destructive" ? "destructive" : "primary"}
            onClick={onConfirm}
            data-testid="pin-shortcut-confirm"
          >
            Send
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function PinsPanel({
  pins,
  selectedAgentName,
  selectedAgentWorkspaceRoot,
  agentIsRunning,
  onRunShortcut,
  pendingPinId = null,
  collapseScope,
}: PinsPanelProps): JSX.Element {
  const [pendingShortcutPin, setPendingShortcutPin] = useState<AgentPin | null>(
    null
  );
  const coarsePointer = useCoarsePointer();
  // This dialog has no DialogTrigger (one instance serves the whole panel), so
  // Radix has nothing to hand focus back to on close — track the button that
  // opened it and restore focus there ourselves.
  const shortcutButtons = useRef(new Map<string, HTMLButtonElement>());
  const lastTrigger = useRef<HTMLButtonElement | null>(null);

  const registerShortcutButton = (
    pin: AgentPin,
    element: HTMLButtonElement | null
  ): void => {
    if (!pin.id) return;
    if (element) shortcutButtons.current.set(pin.id, element);
    else shortcutButtons.current.delete(pin.id);
  };

  // On a touch device the hover tooltip never opens — a tap fires the click —
  // so the prompt would be delivered having shown the user only the label.
  // The confirm dialog already renders the full prompt, so route everything
  // through it there regardless of the pin's own `confirm` setting.
  const handleRunShortcut = (pin: AgentPin, pointerType?: string): void => {
    if (pin.confirm || coarsePointer || pointerType === "touch") {
      lastTrigger.current = pin.id
        ? (shortcutButtons.current.get(pin.id) ?? null)
        : null;
      setPendingShortcutPin(pin);
      return;
    }
    onRunShortcut?.(pin);
  };

  if (pins.length === 0) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-sm text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          <Pin className="h-8 w-8 text-muted-foreground" />
          <div className="mt-4">
            {selectedAgentName
              ? "No pins yet. Agents can pin URLs, files, ports, summaries, and other info here."
              : "Focus an agent to view pins."}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="pins-panel-scroll"
      className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]"
    >
      <PinList
        pins={pins}
        workspaceRoot={selectedAgentWorkspaceRoot}
        agentIsRunning={agentIsRunning}
        onRunShortcut={onRunShortcut ? handleRunShortcut : undefined}
        agentName={selectedAgentName}
        pendingPinId={pendingPinId}
        buttonRef={registerShortcutButton}
        collapseScope={collapseScope ?? null}
      />
      <ConfirmShortcutDialog
        onRestoreFocus={() => lastTrigger.current?.focus()}
        pin={pendingShortcutPin}
        onOpenChange={(open) => {
          if (!open) setPendingShortcutPin(null);
        }}
        onConfirm={() => {
          if (pendingShortcutPin) onRunShortcut?.(pendingShortcutPin);
          setPendingShortcutPin(null);
        }}
      />
    </div>
  );
}
