import * as React from "react";
import * as Primitive from "@radix-ui/react-alert-dialog";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { glassOverlay } from "@/lib/glass";

const AlertDialog = Primitive.Root;
const AlertDialogTitle = Primitive.Title;
const AlertDialogDescription = Primitive.Description;
const AlertDialogContent = React.forwardRef<
  React.ElementRef<typeof Primitive.Content>,
  React.ComponentPropsWithoutRef<typeof Primitive.Content>
>(({ className, ...props }, ref) => (
  <Primitive.Portal>
    <Primitive.Overlay className="fixed inset-0 z-[70] bg-black/50 backdrop-blur-md" />
    <Primitive.Content
      ref={ref}
      className={cn(
        "fixed left-1/2 top-1/2 z-[70] w-[min(480px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 space-y-4 rounded-xl p-5",
        glassOverlay,
        className
      )}
      {...props}
    />
  </Primitive.Portal>
));
AlertDialogContent.displayName = "AlertDialogContent";
const AlertDialogAction = React.forwardRef<
  React.ElementRef<typeof Primitive.Action>,
  React.ComponentPropsWithoutRef<typeof Primitive.Action>
>(({ className, ...props }, ref) => (
  <Button asChild className={className}>
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
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
};
