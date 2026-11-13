import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { glassOverlay } from "@/lib/glass";
import { cn } from "@/lib/utils";
import { useSafeCollisionPadding } from "@/lib/viewport-insets";

const Popover = PopoverPrimitive.Root;

const PopoverAnchor = PopoverPrimitive.Anchor;
/** The open base overlaps the content border so the arrow joins the surface. */
const PopoverArrow = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Arrow>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Arrow>
>(({ className, width = 12, height = 6, ...props }, ref) => (
  <PopoverPrimitive.Arrow {...props} ref={ref} asChild>
    <svg
      width={width}
      height={height}
      viewBox="0 0 12 6"
      preserveAspectRatio="none"
      aria-hidden="true"
      className={cn("overflow-visible", className)}
    >
      <path
        d="M 0 -3 L 0 0 L 6 6 L 12 0 L 12 -3 Z"
        fill="var(--popover-arrow-fill)"
      />
      <path
        d="M 0 0 L 6 6 L 12 0"
        fill="none"
        stroke="var(--popover-arrow-border)"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  </PopoverPrimitive.Arrow>
));
PopoverArrow.displayName = "PopoverArrow";

const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverContent = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> & {
    container?: HTMLElement | null;
  }
>(
  (
    {
      className,
      align = "center",
      sideOffset = 4,
      collisionPadding,
      container,
      ...props
    },
    ref
  ) => {
    const padding = useSafeCollisionPadding(collisionPadding);
    return (
      <PopoverPrimitive.Portal container={container}>
        <PopoverPrimitive.Content
          ref={ref}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={padding}
          className={cn(
            // Never taller than the room Radix measured between the anchor and
            // the padded viewport edge; tall content scrolls inside instead of
            // running off-screen. Callers can still override either class.
            "z-[80] max-h-[var(--radix-popover-content-available-height)] w-72 overflow-y-auto rounded-md p-4 text-popover-foreground outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
            glassOverlay,
            "[--popover-arrow-fill:hsl(var(--popover))] [--popover-arrow-border:rgba(255,255,255,0.2)] border-[color:var(--popover-arrow-border)] bg-popover shadow-[0_16px_64px_rgba(0,0,0,0.5)]",
            className
          )}
          {...props}
        />
      </PopoverPrimitive.Portal>
    );
  }
);
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverAnchor, PopoverArrow, PopoverTrigger, PopoverContent };
