import * as React from "react";

import { cn } from "@/lib/utils";

export interface RowButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
  /**
   * Keeps the row's own height on touch, for dense lists whose rhythm is the
   * content (a turn's activity line and steps). Rows that abut cannot grow a
   * hit area without taking taps from their neighbours, so a dense row must
   * be at least 24px tall itself, or extend into space nothing else uses.
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
        !dense && "pointer-coarse:min-h-11",
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
