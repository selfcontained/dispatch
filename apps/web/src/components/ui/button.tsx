import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-lg text-sm font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "border border-white/[0.06] bg-muted text-foreground shadow-[0_2px_6px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.04)] hover:translate-y-px hover:shadow-[0_1px_2px_rgba(0,0,0,0.3)] active:translate-y-0.5 active:shadow-[0_0px_1px_rgba(0,0,0,0.3)]",
        primary: "bg-primary text-primary-foreground border border-white/[0.08] shadow-[0_2px_8px_rgba(0,0,0,0.3),0_0_16px_hsl(var(--primary)/0.15),inset_0_1px_0_rgba(255,255,255,0.1)] hover:shadow-[0_4px_16px_rgba(0,0,0,0.35),0_0_24px_hsl(var(--primary)/0.25)] hover:-translate-y-px hover:bg-primary/90 active:translate-y-0",
        destructive: "bg-destructive text-destructive-foreground border border-white/[0.06] shadow-[0_2px_8px_rgba(0,0,0,0.3),0_0_12px_hsl(var(--destructive)/0.15)] hover:bg-destructive/90",
        ghost: "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
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
