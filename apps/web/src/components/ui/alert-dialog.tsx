import * as React from "react";
import * as Primitive from "@radix-ui/react-alert-dialog";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { dialogFrame, dialogWidth } from "./dialog";
import { RememberOpener, useReturnFocus } from "./return-focus";

// For a confirmation use ConfirmDialog, which is built from these.
const AlertDialog = Primitive.Root;
const AlertDialogTrigger = Primitive.Trigger;
const AlertDialogTitle = React.forwardRef<
  React.ElementRef<typeof Primitive.Title>,
  React.ComponentPropsWithoutRef<typeof Primitive.Title>
>(({ className, ...props }, ref) => (
  <Primitive.Title
    ref={ref}
    className={cn("break-words text-heading-md", className)}
    {...props}
  />
));
AlertDialogTitle.displayName = "AlertDialogTitle";
const AlertDialogDescription = React.forwardRef<
  React.ElementRef<typeof Primitive.Description>,
  React.ComponentPropsWithoutRef<typeof Primitive.Description>
>(({ className, ...props }, ref) => (
  <Primitive.Description
    ref={ref}
    className={cn("break-words text-body-md text-muted-foreground", className)}
    {...props}
  />
));
AlertDialogDescription.displayName = "AlertDialogDescription";
const AlertDialogContent = React.forwardRef<
  React.ElementRef<typeof Primitive.Content>,
  React.ComponentPropsWithoutRef<typeof Primitive.Content>
>(({ className, children, onCloseAutoFocus, ...props }, ref) => {
  const { opener, restoreFocus } = useReturnFocus();
  return (
    <Primitive.Portal>
      <Primitive.Overlay className="fixed inset-0 z-modal bg-scrim backdrop-blur-md" />
      <Primitive.Content
        ref={ref}
        data-hotkey-disable="true"
        className={cn(dialogFrame, dialogWidth.md, className)}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          restoreFocus(event);
        }}
        {...props}
      >
        <RememberOpener opener={opener} />
        {children}
      </Primitive.Content>
    </Primitive.Portal>
  );
});
AlertDialogContent.displayName = "AlertDialogContent";
const AlertDialogAction = React.forwardRef<
  React.ElementRef<typeof Primitive.Action>,
  React.ComponentPropsWithoutRef<typeof Primitive.Action>
>(({ className, ...props }, ref) => (
  <Button asChild variant="primary" className={className}>
    <Primitive.Action ref={ref} {...props} />
  </Button>
));
AlertDialogAction.displayName = "AlertDialogAction";
const AlertDialogCancel = React.forwardRef<
  React.ElementRef<typeof Primitive.Cancel>,
  React.ComponentPropsWithoutRef<typeof Primitive.Cancel>
>(({ className, ...props }, ref) => (
  <Button asChild variant="ghost" className={className}>
    <Primitive.Cancel ref={ref} {...props} />
  </Button>
));
AlertDialogCancel.displayName = "AlertDialogCancel";
export {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
};
