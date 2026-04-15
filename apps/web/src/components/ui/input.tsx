import * as React from "react";

import { cn } from "@/lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, ...props }, ref) => {
  return (
    <input
      type={type}
      className={cn(
        "flex h-9 w-full rounded-lg border border-white/[0.12] bg-white/[0.04] backdrop-blur-md px-3 py-1 text-sm text-foreground shadow-[inset_0_2px_6px_rgba(0,0,0,0.3)] transition-all duration-150 file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:border-white/[0.25] focus-visible:shadow-[inset_0_2px_6px_rgba(0,0,0,0.3),0_0_0_2px_hsl(var(--ring)/0.3)]",
        className
      )}
      ref={ref}
      {...props}
    />
  );
});
Input.displayName = "Input";

export { Input };
