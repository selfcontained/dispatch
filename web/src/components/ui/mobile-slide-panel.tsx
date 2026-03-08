import { type ReactNode, useEffect } from "react";

import { cn } from "@/lib/utils";

type MobileSlidePanelProps = {
  open: boolean;
  side: "left" | "right";
  label: string;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
};

export function MobileSlidePanel({
  open,
  side,
  label,
  onOpenChange,
  children
}: MobileSlidePanelProps): JSX.Element {
  useEffect(() => {
    if (!open) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChange(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onOpenChange, open]);

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-50 bg-black/70 transition-opacity duration-300",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={() => onOpenChange(false)}
      />
      <div
        className={cn(
          "fixed inset-y-0 z-[60] h-dvh w-screen text-foreground transition-transform duration-300",
          side === "left" ? "left-0" : "right-0",
          open
            ? "translate-x-0"
            : side === "left"
              ? "pointer-events-none -translate-x-full"
              : "pointer-events-none translate-x-full"
        )}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        {children}
      </div>
    </>
  );
}

