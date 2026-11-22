import * as React from "react";

import { cn } from "@/lib/utils";

export interface RowButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
  /**
   * Keeps the row's own height on touch and reaches the 44px target with an
   * invisible overlap instead, for dense lists whose rhythm is the content
   * (a turn's activity line and steps).
   */
  dense?: boolean;
}

/**
 * A clickable row, card or tile: the content sets its shape, the primitive
 * sets hover, selection, focus and the touch target.
 */
const RowButton = React.forwardRef<HTMLButtonElement, RowButtonProps>(
  ({ className, selected, dense, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        "flex w-full items-center gap-2 rounded-md text-left transition-colors focus-ring-inset disabled-state",
        dense
          ? "relative pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-2 pointer-coarse:after:content-['']"
          : "pointer-coarse:min-h-11",
        selected
          ? "bg-surface-selected text-foreground"
          : "hover:bg-surface-hover",
        className
      )}
      {...props}
    />
  )
);
RowButton.displayName = "RowButton";

export { RowButton };
