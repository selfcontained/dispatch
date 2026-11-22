import * as React from "react";

import { glassInset } from "@/lib/glass";
import { cn } from "@/lib/utils";
import { useFieldControl } from "./field-context";

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea"> & {
    /** For a field inside a stream block or another dense surface. */
    dense?: boolean;
  }
>(({ className, dense, ...rest }, ref) => {
  const props = useFieldControl(rest);
  return (
    <textarea
      data-slot="textarea"
      ref={ref}
      className={cn(
        "flex min-h-20 w-full rounded-md px-3 py-2 text-body-md text-foreground transition-colors placeholder:text-muted-foreground focus-ring disabled:cursor-not-allowed disabled-state disabled:pointer-events-auto aria-[invalid=true]:border-danger",
        glassInset,
        dense && "min-h-14 px-2 py-1 text-body-sm pointer-coarse:text-body-lg",
        className
      )}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

export { Textarea };
