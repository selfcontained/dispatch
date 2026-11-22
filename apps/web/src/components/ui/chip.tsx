import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

import { touchTarget } from "./button";

const chipVariants = cva(
  "inline-flex min-w-0 max-w-full items-center whitespace-nowrap rounded-sm border font-normal [&>svg]:size-icon-sm [&>svg]:shrink-0",
  {
    variants: {
      size: {
        sm: "h-5 gap-1 px-1.5 text-label-xs",
        md: "h-6 gap-1.5 px-2 text-label-sm",
      },
      selected: {
        true: "border-primary/line bg-surface-selected text-primary",
        false: "border-border-subtle bg-surface-subtle text-muted-foreground",
      },
    },
    defaultVariants: {
      size: "md",
      selected: false,
    },
  }
);

type ChipVariants = VariantProps<typeof chipVariants>;

/** A compact piece of data: a label, a filter, a link's metadata. */
const Chip = React.forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement> & ChipVariants
>(({ className, size, selected, ...props }, ref) => (
  <span
    ref={ref}
    className={cn(chipVariants({ size, selected }), className)}
    {...props}
  />
));
Chip.displayName = "Chip";

const ChipButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & ChipVariants
>(({ className, size, selected, type = "button", ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    className={cn(
      chipVariants({ size, selected }),
      touchTarget,
      "shrink-0 transition-colors focus-ring disabled-state",
      !selected && "hover:bg-surface-hover hover:text-foreground",
      className
    )}
    {...props}
  />
));
ChipButton.displayName = "ChipButton";

export { Chip, ChipButton };
