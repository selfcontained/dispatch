import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { formatBadgeCount } from "@/lib/format";
import { cn } from "@/lib/utils";

const countBubbleVariants = cva(
  "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-label-xs font-semibold tabular-nums leading-none",
  {
    variants: {
      tone: {
        neutral: "bg-muted text-foreground",
        info: "bg-info-ink text-background",
        warning: "bg-warning-ink text-background",
        danger: "bg-danger text-danger-foreground",
      },
    },
    defaultVariants: {
      tone: "neutral",
    },
  }
);

export interface CountBubbleProps
  extends
    Omit<React.HTMLAttributes<HTMLSpanElement>, "children">,
    VariantProps<typeof countBubbleVariants> {
  /** A number stops at "99+". A total that must read exactly is a string. */
  count: number | string;
}

const CountBubble = React.forwardRef<HTMLSpanElement, CountBubbleProps>(
  ({ className, tone, count, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(countBubbleVariants({ tone }), className)}
      {...props}
    >
      {typeof count === "number" ? formatBadgeCount(count) : count}
    </span>
  )
);
CountBubble.displayName = "CountBubble";

export { CountBubble };
