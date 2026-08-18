import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";

import { cn } from "@/lib/utils";

const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> & {
    horizontal?: boolean;
    /**
     * Radix's Viewport wraps its children in an internal div styled
     * `min-width: 100%; display: table` (see @radix-ui/react-scroll-area's
     * Viewport implementation) so it can measure content for horizontal
     * scrolling. Table sizing means that wrapper grows to fit its content's
     * natural width instead of the container's — so flex-shrink/min-w-0/
     * truncate on descendants never actually engage, and overflow just
     * spills past the Root's overflow-hidden instead of scrolling or
     * eliding. Pass `fitContentWidth` for a vertical list of items that are
     * meant to shrink-to-fit (truncated names, wrapping rows, etc.) rather
     * than to be horizontally scrollable — it forces that wrapper back to
     * `display: block` so it sizes to the container like a normal element.
     * Don't set it on a ScrollArea that intentionally relies on the table
     * sizing for horizontal content (the `horizontal` prop above).
     */
    fitContentWidth?: boolean;
  }
>(({ className, children, horizontal, fitContentWidth, ...props }, ref) => (
  <ScrollAreaPrimitive.Root
    ref={ref}
    className={cn(
      "relative overflow-hidden",
      fitContentWidth && "[&>[data-radix-scroll-area-viewport]>div]:!block",
      className
    )}
    {...props}
  >
    <ScrollAreaPrimitive.Viewport className="h-full max-h-[inherit] w-full rounded-[inherit]">
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar orientation="vertical" />
    {horizontal && <ScrollBar orientation="horizontal" />}
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
));
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Scrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Scrollbar>
>(({ className, orientation = "vertical", ...props }, ref) => (
  <ScrollAreaPrimitive.Scrollbar
    ref={ref}
    orientation={orientation}
    className={cn(
      "flex touch-none select-none transition-colors",
      orientation === "vertical" &&
        "h-full w-2.5 border-l border-l-transparent p-[1px]",
      orientation === "horizontal" &&
        "h-2.5 flex-col border-t border-t-transparent p-[1px]",
      className
    )}
    {...props}
  >
    <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-border" />
  </ScrollAreaPrimitive.Scrollbar>
));
ScrollBar.displayName = ScrollAreaPrimitive.Scrollbar.displayName;

export { ScrollArea, ScrollBar };
