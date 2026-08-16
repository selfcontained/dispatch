import { AlertTriangle, Ban, CornerDownLeft, Loader2 } from "lucide-react";

import { PinCaption } from "@/components/app/pin-value-row";
import { type AgentPin } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { resolvePinShortcutIcon } from "@/lib/pin-shortcut-icons";
import { cn } from "@/lib/utils";

/**
 * Shown both as the tooltip explanation and — when the agent didn't supply a
 * caption — as the caption fallback for a pin it explicitly disabled. Kept as
 * one constant so the two surfaces can't drift apart.
 */
const DISABLED_PIN_REASON = "This action is currently unavailable.";

export function ShortcutPinItem({
  pin,
  agentUnavailable,
  pending,
  onRun,
  inGroup,
  agentName,
  buttonRef,
}: {
  pin: AgentPin;
  agentUnavailable: boolean;
  pending: boolean;
  onRun: (pointerType: string) => void;
  inGroup: boolean;
  agentName: string | null;
  buttonRef?: (pin: AgentPin, element: HTMLButtonElement | null) => void;
}): JSX.Element {
  const coarsePointer = useCoarsePointer();
  // A destructive shortcut's colour is its only pre-click warning, and some
  // themes render primary and destructive almost identically — so carry the
  // warning in the glyph too, which no palette can wash out. An agent-disabled
  // pin outranks both: it's a deliberate, semi-durable state (not a passing
  // "agent isn't running yet"), and needs to read differently at a glance
  // from the other blocked states below, which share the same dimmed styling.
  const Icon = pin.disabled
    ? Ban
    : pin.variant === "destructive"
      ? AlertTriangle
      : resolvePinShortcutIcon(pin.icon);
  // No ID means the run endpoint has nothing to address; render it inert
  // rather than as a button that silently does nothing on click. An
  // agent-set `disabled` is a third, independent reason a shortcut can't
  // fire — checked here rather than folded into `agentUnavailable` so its
  // tooltip copy stays distinct from "agent not running".
  const unavailable = agentUnavailable || !pin.id || Boolean(pin.disabled);
  const blocked = unavailable || pending;
  const disabledReason = !pin.id
    ? "This pin has no stable ID, so it cannot be run."
    : pin.disabled
      ? DISABLED_PIN_REASON
      : `${agentName ?? "This agent"} has no active session — shortcuts are unavailable.`;
  // The tooltip needs a hover, which touch devices can't reach — so a
  // disabled pin with no caption of its own falls back to the same reason
  // text there, and a stale pre-disable caption never masks it.
  const captionValue =
    pin.caption ?? (pin.disabled ? DISABLED_PIN_REASON : undefined);

  return (
    <div
      className={cn(
        inGroup
          ? "py-1.5 first:pt-0 last:pb-0"
          : "px-4 py-2.5 border-b border-border last:border-b-0"
      )}
      data-testid="pin-item"
      data-pin-label={pin.label}
      data-pin-type="shortcut"
      data-pin-disabled={pin.disabled ? "true" : undefined}
    >
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              ref={(element) => buttonRef?.(pin, element)}
              variant={pin.variant ?? "default"}
              size="sm"
              className={cn(
                "relative w-full gap-1.5 pl-2 pr-7",
                // The shared `default` variant is dark-theme glass — white at
                // 6% over a light sidebar is invisible. Mix off the surface
                // the sidebar actually paints (--card) toward the foreground:
                // keying off --muted fails on themes where it equals --card.
                (pin.variant ?? "default") === "default" &&
                  "border-foreground/25 bg-[color-mix(in_srgb,hsl(var(--card))_90%,hsl(var(--foreground)))] text-foreground hover:bg-[color-mix(in_srgb,hsl(var(--card))_82%,hsl(var(--foreground)))]",
                // 32px is below the 44px touch minimum, and these stack.
                coarsePointer && "h-11",
                blocked && "cursor-not-allowed opacity-50"
              )}
              // aria-disabled rather than `disabled`: the native attribute
              // drops the button out of the tab order, which is where the
              // explanation for why it is unavailable lives.
              aria-disabled={blocked}
              onClick={(event) => {
                if (blocked) return;
                onRun(
                  (event.nativeEvent as PointerEvent).pointerType ?? "mouse"
                );
              }}
            >
              {pending ? (
                <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
              ) : (
                <Icon className="h-3 w-3 shrink-0" />
              )}
              <span className="min-w-0 truncate">{pin.label}</span>
              {/* Constant send glyph: every shortcut pin delivers a prompt,
                  whatever icon the agent chose for it. */}
              <CornerDownLeft
                className="absolute right-2 h-3 w-3 shrink-0 opacity-50"
                aria-hidden
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent
            side="left"
            // A lighter neutral surface rather than an accent: every accent
            // token in the palette maps onto a button variant's hue. Mixing
            // the popover token toward the foreground lifts it off the card
            // behind it in dark themes and deepens it in light ones, so the
            // separation holds either way.
            className="max-w-[320px] border-[hsl(var(--border))] bg-[color-mix(in_srgb,hsl(var(--popover))_88%,hsl(var(--foreground)))] p-2.5"
          >
            {unavailable ? (
              <p className="m-0 text-xs text-muted-foreground">
                {disabledReason}
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                <div>
                  {/* The label is truncated in the button, so the tooltip is
                      the only place it can be read in full. */}
                  <div className="text-xs font-semibold text-foreground">
                    {pin.label}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {agentName ?? "this agent"} will receive the following:
                  </div>
                </div>
                {/* The prompt reads as a quoted payload, not prose — same
                    monospace treatment the terminal will show it in. */}
                <pre className="m-0 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground">
                  {pin.value}
                </pre>
                {pin.value.length > 400 ? (
                  <div className="text-[11px] text-muted-foreground">
                    Scroll for the full prompt ({pin.value.length} characters).
                  </div>
                ) : null}
              </div>
            )}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {captionValue ? <PinCaption value={captionValue} /> : null}
    </div>
  );
}
