import { Loader2 } from "lucide-react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { SurfaceIconGlyph } from "@/components/app/agent-surfaces/surface-icon";
import type { ActionRef } from "@/components/app/agent-surfaces/types";
import { cn } from "@/lib/utils";

/** Canonical `ActionRef.style` -> Button `variant`, shared so an action
 * button and a form submit button render the same way for the same style
 * (including "destructive"). `ActionRef["style"]` values pass straight
 * through as Button variant names; the return type annotation is what keeps
 * this coupled to Button's variant union at compile time — if Button ever
 * drops one of these variants, this stops compiling. */
export function actionButtonVariant(
  style: ActionRef["style"]
): NonNullable<ButtonProps["variant"]> {
  return style ?? "default";
}

/**
 * Renders one `ActionRef` as a button: icon (or a submitting spinner in its
 * place), style variant, and label. Used for both actions-block's action
 * buttons and form-block's submit button so an agent-authored action looks
 * and behaves the same wherever it appears.
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
}: {
  action: ActionRef;
  type?: "button" | "submit";
  className?: string;
  busy: boolean;
  disabled: boolean;
  authoredDisabled?: boolean;
  onClick?: () => void;
  disabledReasonId?: string;
}): JSX.Element {
  const blocked = disabled || authoredDisabled;
  return (
    <Button
      type={type}
      variant={actionButtonVariant(action.style)}
      size="sm"
      className={cn(
        // Compact by default; grows to the 44px touch-target minimum only
        // for coarse (touch) pointers.
        "[@media(pointer:coarse)]:min-h-11",
        authoredDisabled && "opacity-50",
        className
      )}
      disabled={disabled}
      aria-disabled={!disabled && authoredDisabled ? true : undefined}
      aria-describedby={disabledReasonId}
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
