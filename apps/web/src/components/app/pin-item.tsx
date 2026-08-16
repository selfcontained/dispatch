import { ShortcutPinItem } from "@/components/app/pin-shortcut-item";
import {
  CopyButton,
  PinCaption,
  PinValueRow,
} from "@/components/app/pin-value-row";
import { type AgentPin } from "@/components/app/types";
import { splitPinValues } from "@/lib/pins";
import { rewritePinUrl } from "@/lib/rewrite-pin-url";
import { cn } from "@/lib/utils";

export function PinItem({
  pin,
  workspaceRoot,
  agentIsRunning = true,
  onRunShortcut,
  inGroup = false,
  agentName = null,
  pendingPinId = null,
  buttonRef,
}: {
  pin: AgentPin;
  workspaceRoot: string | null;
  agentIsRunning?: boolean;
  onRunShortcut?: (pin: AgentPin, pointerType?: string) => void;
  inGroup?: boolean;
  agentName?: string | null;
  pendingPinId?: string | null;
  buttonRef?: (pin: AgentPin, element: HTMLButtonElement | null) => void;
}): JSX.Element {
  if (pin.type === "shortcut") {
    return (
      <ShortcutPinItem
        pin={pin}
        agentUnavailable={!agentIsRunning || !onRunShortcut}
        pending={Boolean(pin.id) && pin.id === pendingPinId}
        onRun={(pointerType) => onRunShortcut?.(pin, pointerType)}
        inGroup={inGroup}
        agentName={agentName}
        buttonRef={buttonRef}
      />
    );
  }

  const effectiveValue =
    pin.type === "url"
      ? rewritePinUrl(pin.value, window.location.host)
      : pin.value;
  const values = splitPinValues(pin.type, effectiveValue);
  const isMulti = values.length > 1;

  return (
    <div
      className={cn(
        inGroup
          ? "py-1.5 first:pt-0 last:pb-0"
          : "px-4 py-2.5 border-b border-border last:border-b-0"
      )}
      data-testid="pin-item"
      data-pin-label={pin.label}
    >
      <div className="flex items-center gap-1">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80">
          {pin.label}
        </div>
        <div className="ml-auto">
          <CopyButton
            value={effectiveValue}
            title={isMulti ? "Copy all" : "Copy to clipboard"}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1 mt-1">
        {values.map((v, i) => (
          <PinValueRow
            key={i}
            type={pin.type}
            value={v}
            workspaceRoot={workspaceRoot}
          />
        ))}
      </div>
      {pin.caption ? <PinCaption value={pin.caption} /> : null}
    </div>
  );
}
