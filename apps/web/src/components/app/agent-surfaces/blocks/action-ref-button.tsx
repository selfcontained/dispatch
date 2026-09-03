import { Loader2 } from "lucide-react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { SurfaceIconGlyph } from "@/components/app/agent-surfaces/surface-icon";
import type { ActionRef } from "@/components/app/agent-surfaces/types";
import { cn } from "@/lib/utils";

/** Canonical `ActionRef.style` -> Button `variant`. The mapping is where the
 * emphasis policy lives: `primary` is the loudest thing on a surface,
 * `default` is quiet chrome, and `destructive` maps to the *ghost* danger
 * variant — an irreversible verb should be findable, not the brightest object
 * on screen. The return type annotation keeps this coupled to Button's
 * variant union at compile time. */
export function actionButtonVariant(
  style: ActionRef["style"]
): NonNullable<ButtonProps["variant"]> {
  if (style === "destructive") return "ghost-destructive";
  return style ?? "default";
}

/**
 * Renders one `ActionRef` as a compact button: icon (or a submitting spinner
 * in its place), emphasis variant, and label. Used by the slot-actions
 * split button and the form submit so an agent-authored action looks and
 * behaves the same wherever it appears. Buttons on a surface are quieter
 * than content — h-7 visual box, with the 44px coarse-pointer hit area kept.
 *
 * `disabled` and `authoredDisabled` are deliberately distinct props. `disabled`
 * covers transient/system reasons (already submitting, already queued or
 * notified, the surface is read-only) and renders as a real native-disabled
 * button. `authoredDisabled` is the agent's own `disabledReason` — that stays
 * focusable via `aria-disabled` instead of the native attribute, so keyboard
 * and screen-reader users can still reach the button and hear the reason
 * (wired via `disabledReasonId`/`aria-describedby`) rather than have it
 * silently drop out of the tab order.
 */
export function ActionRefButton({
  action,
  type = "button",
  className,
  busy,
  disabled,
  authoredDisabled = false,
  onClick,
  disabledReasonId,
  ariaLabel,
  variantOverride,
}: {
  action: Pick<
    ActionRef,
    "id" | "label" | "icon" | "style" | "disabledReason"
  > & { style?: ActionRef["style"] };
  type?: "button" | "submit";
  className?: string;
  busy: boolean;
  disabled: boolean;
  authoredDisabled?: boolean;
  onClick?: () => void;
  disabledReasonId?: string;
  ariaLabel?: string;
  /** Renderer policy hook: a form submit is always primary, a split-button
   * main segment keeps its own emphasis. */
  variantOverride?: NonNullable<ButtonProps["variant"]>;
}): JSX.Element {
  const blocked = disabled || authoredDisabled;
  return (
    <Button
      type={type}
      variant={variantOverride ?? actionButtonVariant(action.style)}
      size="sm"
      className={cn(
        // Compact by default; grows to the 44px touch-target minimum only
        // for coarse (touch) pointers.
        "h-7 px-2.5 text-xs [@media(pointer:coarse)]:min-h-11",
        // A destructive verb rendered as a standalone button keeps a visible
        // border so it still reads as a button, just a quiet one.
        (variantOverride ?? actionButtonVariant(action.style)) ===
          "ghost-destructive" && "border border-status-blocked/30",
        authoredDisabled && "opacity-50",
        className
      )}
      disabled={disabled}
      aria-disabled={!disabled && authoredDisabled ? true : undefined}
      aria-describedby={disabledReasonId}
      aria-label={ariaLabel}
      onClick={() => {
        if (blocked) return;
        onClick?.();
      }}
      data-action-id={action.id}
    >
      {busy ? (
        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
      ) : (
        <SurfaceIconGlyph icon={action.icon} className="mr-1.5 h-3.5 w-3.5" />
      )}
      {action.label}
    </Button>
  );
}
