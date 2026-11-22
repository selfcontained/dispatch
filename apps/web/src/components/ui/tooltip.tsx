import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "@/lib/utils";

const HasProviderContext = React.createContext(false);

function TooltipProvider({
  children,
  delayDuration = 300,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration} {...props}>
      <HasProviderContext.Provider value={true}>
        {children}
      </HasProviderContext.Provider>
    </TooltipPrimitive.Provider>
  );
}

const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={8}
      className={cn(
        "z-tooltip max-w-xs overflow-hidden whitespace-pre-line break-words rounded-md border border-edge-strong bg-card px-2 py-1 text-body-sm text-foreground shadow-elev-floating",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:animate-in",
        "data-[state=delayed-open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=delayed-open]:zoom-in-95",
        "data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1",
        "data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1",
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

// A hint opens on focus only when the keyboard moved focus there. Focus that
// a dialog or menu places on open or close would otherwise open one, and that
// tooltip would swallow the Escape meant for the dialog.
let keyboardNavigating = false;
if (typeof document !== "undefined") {
  document.addEventListener(
    "keydown",
    (event) => {
      keyboardNavigating = event.key === "Tab" || event.key.startsWith("Arrow");
    },
    true
  );
  document.addEventListener(
    "pointerdown",
    () => {
      keyboardNavigating = false;
    },
    true
  );
}

export interface HintProps extends Omit<
  React.HTMLAttributes<HTMLElement>,
  "children"
> {
  label: React.ReactNode;
  children: React.ReactElement;
  side?: React.ComponentPropsWithoutRef<typeof TooltipContent>["side"];
}

/**
 * A short explanation of one element, in place of `title=`. It passes on what
 * it is given, so it can sit inside another trigger's `asChild`. Put it there,
 * not around the trigger: Tooltip's `data-state` would replace the trigger's.
 */
const Hint = React.forwardRef<HTMLElement, HintProps>(
  ({ label, children, side, onFocus, ...props }, ref) => {
    const hasProvider = React.useContext(HasProviderContext);
    if (!label) {
      return (
        <Slot ref={ref} onFocus={onFocus} {...props}>
          {children}
        </Slot>
      );
    }
    const hint = (
      <Tooltip disableHoverableContent>
        <TooltipTrigger
          asChild
          ref={ref as React.Ref<HTMLButtonElement>}
          onFocus={(event) => {
            onFocus?.(event);
            if (!keyboardNavigating) event.preventDefault();
          }}
          {...props}
        >
          {children}
        </TooltipTrigger>
        <TooltipContent side={side} data-hint="">
          {label}
        </TooltipContent>
      </Tooltip>
    );
    return hasProvider ? hint : <TooltipProvider>{hint}</TooltipProvider>;
  }
);
Hint.displayName = "Hint";

export { Hint, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
