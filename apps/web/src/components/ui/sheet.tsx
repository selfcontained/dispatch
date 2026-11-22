import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetTitle = SheetPrimitive.Title;
const SheetContent = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <SheetPrimitive.Portal>
    <SheetPrimitive.Overlay className="notifications-sheet-overlay fixed inset-0 z-popover bg-scrim" />
    <SheetPrimitive.Content
      ref={ref}
      className={cn(
        "notifications-sheet fixed inset-y-0 right-0 z-popover flex h-full w-full flex-col border-l bg-background shadow-lg sm:max-w-md",
        className
      )}
      {...props}
    >
      {children}
      <SheetPrimitive.Close className="absolute right-4 top-[max(1rem,var(--safe-area-top))] rounded-sm text-muted-foreground hover:text-foreground focus-ring">
        <X className="size-5" />
        <span className="sr-only">Close notifications</span>
      </SheetPrimitive.Close>
    </SheetPrimitive.Content>
  </SheetPrimitive.Portal>
));
SheetContent.displayName = "SheetContent";
export { Sheet, SheetTrigger, SheetTitle, SheetContent };
