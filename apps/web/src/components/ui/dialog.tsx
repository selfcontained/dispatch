import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import { glassOverlay } from "@/lib/glass";
import { cn } from "@/lib/utils";
import { useVisualViewportVars } from "@/lib/viewport-insets";

const Dialog = DialogPrimitive.Root;
// DialogClose has no importers today. It is kept on purpose: this is a
// vendored shadcn primitive whose API surface is meant to mirror Radix's, and
// dropping parts of it makes the next `Dialog` consumer reach for
// DialogPrimitive directly. Do not flag it as dead code.
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-[70] bg-black/50 backdrop-blur-md",
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/**
 * Centre the dialog in the part of the screen the user can actually see —
 * the visual viewport (keyboard up, zoomed) minus the device safe areas
 * (iOS status bar, home indicator) — and never let it grow past that space.
 * Content that is taller scrolls inside the dialog's own scroll region, so
 * the title and the footer actions stay on screen. `--vv-*` come from
 * useVisualViewportVars and fall back to the dynamic viewport.
 */
const DIALOG_VIEWPORT_FIT = "dialog-viewport-fit";

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    overlayClassName?: string;
  }
>(({ className, overlayClassName, style, ...props }, ref) => {
  const viewportVars = useVisualViewportVars();
  return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        ref={ref}
        data-hotkey-disable="true"
        className={cn(
          "fixed left-1/2 z-[70] flex flex-col w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-3 overflow-hidden rounded-xl p-4",
          DIALOG_VIEWPORT_FIT,
          glassOverlay,
          className
        )}
        style={{ ...viewportVars, ...style }}
        {...props}
      />
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-1.5", className)} {...props} />
);

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
};
