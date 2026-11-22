import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const statusDotVariants = cva("inline-block shrink-0 rounded-full", {
  variants: {
    tone: {
      working: "bg-status-working",
      blocked: "bg-status-blocked",
      waiting: "bg-status-waiting",
      done: "bg-status-done",
      merged: "bg-status-merged",
      idle: "bg-status-idle",
      reviewing: "bg-status-reviewing",
      success: "bg-success",
      warning: "bg-warning",
      danger: "bg-danger",
      info: "bg-info",
      neutral: "bg-muted-foreground",
      current: "bg-current",
    },
    size: {
      sm: "size-1.5",
      md: "size-2",
    },
  },
  defaultVariants: {
    size: "md",
  },
});

export type StatusDotTone = NonNullable<
  VariantProps<typeof statusDotVariants>["tone"]
>;

export interface StatusDotProps
  extends
    Omit<React.HTMLAttributes<HTMLSpanElement>, "color">,
    VariantProps<typeof statusDotVariants> {
  /** A colour that is data, such as a task column's or label's. */
  color?: string;
}

const StatusDot = React.forwardRef<HTMLSpanElement, StatusDotProps>(
  ({ className, tone, size, color, style, ...props }, ref) => (
    <span
      ref={ref}
      aria-hidden="true"
      className={cn(statusDotVariants({ tone, size }), className)}
      style={color ? { ...style, backgroundColor: color } : style}
      {...props}
    />
  )
);
StatusDot.displayName = "StatusDot";

export { StatusDot };
