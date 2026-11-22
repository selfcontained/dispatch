import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex max-w-full shrink-0 items-center whitespace-nowrap rounded-sm border font-medium [&>svg]:size-icon-sm [&>svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "border-border bg-muted text-muted-foreground",
        success: "border-success/line bg-success/tint text-success",
        warning: "border-warning/line bg-warning/tint text-warning",
        danger: "border-danger/line bg-danger/tint text-danger",
        info: "border-info/line bg-info/tint text-info",
        merged:
          "border-status-merged/line bg-status-merged/tint text-status-merged",
      },
      appearance: {
        tint: "",
        outline: "bg-transparent",
      },
      size: {
        sm: "gap-1 px-1.5 text-label-xs",
        md: "gap-1 px-2 py-0.5 text-label-sm",
      },
    },
    defaultVariants: {
      tone: "neutral",
      appearance: "tint",
      size: "md",
    },
  }
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;

export interface BadgeProps
  extends
    React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /** Leads with a dot in the badge's colour. */
  dot?: boolean;
}

const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, tone, appearance, size, dot, children, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(badgeVariants({ tone, appearance, size }), className)}
      {...props}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full bg-current"
        />
      ) : null}
      {children}
    </span>
  )
);
Badge.displayName = "Badge";

export { Badge };
