import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

// shadcn Sheet composition, using the existing Radix Dialog dependency.
export const Sheet = DialogPrimitive.Root;
export const SheetTitle = DialogPrimitive.Title;
export const SheetDescription = DialogPrimitive.Description;
export function SheetContent({
  children,
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-[80] bg-black/50" />
      <DialogPrimitive.Content
        data-hotkey-disable="true"
        className={cn(
          "fixed inset-x-0 bottom-0 z-[80] flex h-[85dvh] flex-col gap-3 border-t bg-background p-4 shadow-lg sm:inset-x-auto sm:inset-y-0 sm:right-0 sm:h-dvh sm:w-[min(900px,90vw)] sm:border-l",
          className
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          className="absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
          aria-label="Hide terminal"
        >
          <X className="h-4 w-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
