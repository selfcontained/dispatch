import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide backdrop-blur-md shadow-[0_1px_4px_rgba(0,0,0,0.25)]",
  {
    variants: {
      variant: {
        default: "border-white/[0.15] bg-white/[0.08] text-muted-foreground",
        running: "border-status-working/40 bg-status-working/15 text-status-working shadow-[0_0_8px_hsl(var(--status-working)/0.1)]",
        stopped: "border-status-waiting/35 bg-status-waiting/15 text-status-waiting shadow-[0_0_8px_hsl(var(--status-waiting)/0.1)]",
        error: "border-status-blocked/40 bg-status-blocked/15 text-status-blocked shadow-[0_0_8px_hsl(var(--status-blocked)/0.1)]",
        transitional: "border-status-done/35 bg-status-done/15 text-status-done shadow-[0_0_8px_hsl(var(--status-done)/0.1)]"
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
