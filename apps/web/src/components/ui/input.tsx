import * as React from "react";

import { glassInset } from "@/lib/glass";
import { cn } from "@/lib/utils";
import { useFieldControl } from "./field-context";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  /** 28px, for a field inside a stream block or another dense surface. */
  dense?: boolean;
};

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, dense, ...rest }, ref) => {
    const props = useFieldControl(rest);
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-md px-3 py-1 text-body-md text-foreground transition-colors file:border-0 file:bg-transparent file:text-body-md file:font-medium placeholder:text-muted-foreground focus-ring aria-[invalid=true]:border-danger pointer-coarse:min-h-11",
          glassInset,
          // 16px on touch, or iOS zooms the page on focus.
          dense && "h-7 px-2 text-body-sm pointer-coarse:text-body-lg",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

export { Input };
