import * as React from "react";

import { glassInset } from "@/lib/glass";
import { cn } from "@/lib/utils";
import { useFieldControl } from "./field-context";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...rest }, ref) => {
    const props = useFieldControl(rest);
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-md px-3 py-1 text-body-md text-foreground transition-colors file:border-0 file:bg-transparent file:text-body-md file:font-medium placeholder:text-muted-foreground focus-ring aria-[invalid=true]:border-danger pointer-coarse:min-h-11",
          glassInset,
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
