import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { glassOverlay } from "@/lib/glass";
import { cn } from "@/lib/utils";
import { Button, type ButtonProps } from "./button";
import { IconButton } from "./icon-button";
import { RememberOpener, useReturnFocus } from "./return-focus";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

/** A request in flight: nothing closes the dialog until it settles. */
const BusyContext = React.createContext(false);

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn("fixed inset-0 z-modal bg-scrim backdrop-blur-md", className)}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

export const dialogFrame = cn(
  "group/dialog fixed left-1/2 top-1/2 z-modal flex max-h-[min(85vh,calc(100dvh-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-hidden rounded-xl p-5",
  glassOverlay
);

export const dialogWidth = {
  sm: "w-[min(400px,calc(100vw-2rem))]",
  md: "w-[min(560px,calc(100vw-2rem))]",
  lg: "w-[min(720px,calc(100vw-2rem))]",
  xl: "w-[min(960px,calc(100vw-2rem))]",
};

const PHONE = {
  center: "",
  fill: "max-md:inset-0 max-md:h-dvh max-md:max-h-none max-md:w-full max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none max-md:pb-safe-4 max-md:pt-safe-4",
  sheet:
    "max-md:inset-x-0 max-md:bottom-0 max-md:top-auto max-md:max-h-[85dvh] max-md:w-full max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-b-none max-md:pb-safe-4",
};

export interface DialogContentProps extends React.ComponentPropsWithoutRef<
  typeof DialogPrimitive.Content
> {
  overlayClassName?: string;
  size?: keyof typeof dialogWidth;
  /** On a phone: centred, the whole screen for a long form, or a bottom sheet. */
  phone?: keyof typeof PHONE;
  busy?: boolean;
  /** A full-screen viewer or editor that draws its own frame and close. */
  bare?: boolean;
}

/**
 * The close button, Esc and a click outside all close it, and all three wait
 * while `busy`. Compose it from DialogHeader, DialogBody and DialogFooter.
 */
/**
 * Radix hears Escape before the field does. A popover is a layer of its own,
 * but a suggestion list drawn in the body (PathInput) has only this.
 */
function inOpenSuggestions(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.matches(
      'input[role="combobox"][aria-expanded="true"]:not([cmdk-input])'
    )
  );
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(
  (
    {
      className,
      overlayClassName,
      size = "md",
      phone = "center",
      busy = false,
      bare = false,
      children,
      onEscapeKeyDown,
      onInteractOutside,
      onCloseAutoFocus,
      ...props
    },
    ref
  ) => {
    const { opener, restoreFocus } = useReturnFocus();
    return (
      <DialogPortal>
        <DialogOverlay className={overlayClassName} />
        <DialogPrimitive.Content
          ref={ref}
          data-hotkey-disable="true"
          aria-busy={busy || undefined}
          className={cn(
            dialogFrame,
            !bare && [dialogWidth[size], PHONE[phone]],
            className
          )}
          onEscapeKeyDown={(event) => {
            onEscapeKeyDown?.(event);
            if (busy || inOpenSuggestions(event.target)) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            onInteractOutside?.(event);
            // A toast sits over the dialog; using it is not a click outside.
            if (
              busy ||
              (event.target instanceof Element &&
                event.target.closest("[data-sonner-toaster]"))
            )
              event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event);
            restoreFocus(event);
          }}
          {...props}
        >
          <RememberOpener opener={opener} />
          <BusyContext.Provider value={busy}>{children}</BusyContext.Provider>
          {/* Last, so opening focuses the content before the close button. */}
          {bare ? null : (
            <DialogPrimitive.Close asChild>
              <IconButton
                size="icon-sm"
                label="Close"
                disabled={busy}
                className={cn(
                  "absolute right-3 top-3 z-sticky pointer-coarse:right-1.5 pointer-coarse:top-1.5",
                  phone === "fill" &&
                    "max-md:top-[max(0.75rem,var(--safe-area-top))]"
                )}
              >
                <X />
              </IconButton>
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </DialogPortal>
    );
  }
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex min-w-0 shrink-0 flex-col space-y-1.5 pr-8 text-left pointer-coarse:pr-11",
      className
    )}
    {...props}
  />
);

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("break-words text-heading-md", className)}
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
    className={cn("break-words text-body-md text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

/** The part that scrolls. `className` lays out what is inside it. */
const DialogBody = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, children, ...props }, forwardedRef) => {
  const scroller = React.useRef<HTMLDivElement | null>(null);
  const inner = React.useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = React.useState(false);
  React.useImperativeHandle(forwardedRef, () => scroller.current!);
  React.useLayoutEffect(() => {
    const box = scroller.current;
    if (!box || !inner.current) return;
    const measure = () =>
      setScrollable(box.scrollHeight > box.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(inner.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={scroller}
      data-scrollable={scrollable}
      className="-mx-5 -my-1 min-h-0 flex-auto overflow-y-auto overflow-x-hidden overscroll-contain scroll-p-2 px-5 py-1"
      {...props}
    >
      <div ref={inner} className={className}>
        {children}
      </div>
    </div>
  );
});
DialogBody.displayName = "DialogBody";

/** A form that spans the body and the footer. */
const DialogForm = React.forwardRef<
  HTMLFormElement,
  React.FormHTMLAttributes<HTMLFormElement>
>(({ className, ...props }, ref) => (
  <form
    ref={ref}
    className={cn("flex min-h-0 flex-auto flex-col gap-4", className)}
    {...props}
  />
));
DialogForm.displayName = "DialogForm";

/**
 * Right-aligned: Cancel, any other choice, then the primary. A tertiary or
 * destructive action that isn't the dialog's purpose goes in `start`.
 */
const DialogFooter = ({
  start,
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { start?: React.ReactNode }) => (
  <div
    className={cn(
      "-mx-5 -mt-1 flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-transparent px-5 pt-3 group-has-[[data-scrollable=true]]/dialog:border-border-subtle",
      className
    )}
    {...props}
  >
    {start ? (
      <>
        <div className="mr-auto flex min-w-0 flex-wrap items-center gap-2">
          {start}
        </div>
        {/* Cancel and the primary wrap as a pair. */}
        <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
          {children}
        </div>
      </>
    ) : (
      children
    )}
  </div>
);

const DialogCancel = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ children = "Cancel", disabled, ...props }, ref) => {
    const busy = React.useContext(BusyContext);
    return (
      <DialogPrimitive.Close asChild>
        <Button
          ref={ref}
          type="button"
          variant="ghost"
          disabled={busy || disabled}
          {...props}
        >
          {children}
        </Button>
      </DialogPrimitive.Close>
    );
  }
);
DialogCancel.displayName = "DialogCancel";

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
  DialogBody,
  DialogForm,
  DialogFooter,
  DialogCancel,
};
