import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-lg text-sm font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "border border-white/[0.12] bg-white/[0.06] backdrop-blur-md text-foreground shadow-[0_1px_4px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.06)] hover:bg-white/[0.1] hover:border-white/[0.18]",
        primary: "bg-primary/80 backdrop-blur-md text-primary-foreground border border-white/[0.15] shadow-[0_2px_8px_rgba(0,0,0,0.25),0_0_20px_hsl(var(--primary)/0.25),inset_0_1px_0_rgba(255,255,255,0.15)] hover:shadow-[0_2px_8px_rgba(0,0,0,0.25),0_0_32px_hsl(var(--primary)/0.35)] hover:bg-primary/90",
        destructive: "bg-destructive/80 backdrop-blur-md text-destructive-foreground border border-white/[0.1] shadow-[0_2px_8px_rgba(0,0,0,0.25),0_0_16px_hsl(var(--destructive)/0.2)] hover:bg-destructive/90",
        ghost: "text-muted-foreground hover:bg-white/[0.06] hover:text-foreground",
        "ghost-primary":
          "text-status-working hover:bg-status-working/15 hover:text-status-working",
        "ghost-info":
          "text-status-done hover:bg-status-done/15 hover:text-status-done",
        "ghost-destructive":
          "text-status-blocked hover:bg-status-blocked/15 hover:text-status-blocked",
        "ghost-warning":
          "text-status-waiting hover:bg-status-waiting/15 hover:text-status-waiting"
      },
      size: {
        default: "h-9 px-3 py-2",
        sm: "h-8 rounded-md px-2.5",
        icon: "h-8 w-8"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
