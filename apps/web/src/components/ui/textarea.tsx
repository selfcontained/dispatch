import * as React from "react";

import { glassInset } from "@/lib/glass";
import { cn } from "@/lib/utils";

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      data-slot="textarea"
      ref={ref}
      className={cn(
        "flex min-h-20 w-full rounded-md px-3 py-2 text-body-md text-foreground transition-colors placeholder:text-muted-foreground focus-ring disabled:cursor-not-allowed disabled-state disabled:pointer-events-auto",
        glassInset,
        className
      )}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

export { Textarea };
