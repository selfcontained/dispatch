import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide",
  {
    variants: {
      variant: {
        default: "border-border bg-muted text-muted-foreground",
        running: "border-status-working/40 bg-status-working/15 text-status-working",
        stopped: "border-status-waiting/35 bg-status-waiting/15 text-status-waiting",
        error: "border-status-blocked/40 bg-status-blocked/15 text-status-blocked",
        transitional: "border-status-done/35 bg-status-done/15 text-status-done"
      }
    },
    defaultVariants: {
      variant: "default"
    }
  }
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps): JSX.Element {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
