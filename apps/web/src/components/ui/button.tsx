import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-body-md font-medium transition-colors focus-ring disabled-state",
  {
    variants: {
      variant: {
        default:
          "border border-edge bg-fill-raised text-foreground backdrop-blur-md shadow-elev-control hover:bg-fill-hover hover:border-edge-strong",
        primary:
          "bg-primary/soft text-primary-foreground backdrop-blur-md border border-edge-on-color shadow-elev-primary hover:bg-primary/dense hover:shadow-elev-primary-hover",
        success:
          "border border-success/line bg-success/soft text-background shadow-sm hover:bg-success/dense",
        destructive: "bg-danger text-danger-foreground hover:bg-danger/dense",
        ghost:
          "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
        "ghost-primary":
          "text-success hover:bg-success/tint-strong hover:text-success",
        "ghost-info": "text-info hover:bg-info/tint-strong hover:text-info",
        "ghost-destructive":
          "text-danger hover:bg-danger/tint-strong hover:text-danger",
        "ghost-warning":
          "text-warning hover:bg-warning/tint-strong hover:text-warning",
      },
      size: {
        default: "h-9 px-3 py-2",
        sm: "h-8 rounded-md px-2",
        icon: "h-8 w-8 shrink-0 p-0",
        "icon-sm": "h-7 w-7 shrink-0 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button };
