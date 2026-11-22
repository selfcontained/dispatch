import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2 py-0.5 text-label-sm font-medium uppercase tracking-wide",
  {
    variants: {
      variant: {
        default: "border-border bg-muted text-muted-foreground",
        running: "border-success/line bg-success/tint text-success",
        stopped: "border-warning/line bg-warning/tint text-warning",
        error: "border-danger/line bg-danger/tint text-danger",
        transitional: "border-info/line bg-info/tint text-info",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends
    React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps): JSX.Element {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge };
