import type { LucideIcon } from "lucide-react";
import { X } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";
import { IconButton } from "./icon-button";

/** One card for every toast: the colour is in the bar, tile and label only. */
export function ToastCard({
  Icon,
  tone,
  cover,
  onDismiss,
  className,
  children,
  bodyProps,
}: {
  Icon: LucideIcon;
  /** Literal classes, for Tailwind. */
  tone: { border: string; bar: string; tile: string };
  /** An action over the whole body, under what is in it. */
  cover?: React.ReactNode;
  onDismiss?: () => void;
  className?: string;
  children: React.ReactNode;
  bodyProps?: Record<`data-${string}`, string>;
}): JSX.Element {
  return (
    <div
      className={cn(
        "flex w-full items-stretch border bg-popover text-popover-foreground shadow-elev-popover transition-colors [font-family:var(--font-ui)]",
        tone.border,
        className
      )}
    >
      <span aria-hidden className={cn("w-1 shrink-0", tone.bar)} />
      <div
        className="relative flex min-w-0 flex-1 items-start gap-3 px-3 py-3 text-left"
        {...bodyProps}
      >
        {cover}
        <span
          aria-hidden
          className={cn(
            "pointer-events-none flex size-9 shrink-0 items-center justify-center text-background",
            tone.tile
          )}
        >
          <Icon className="size-5" strokeWidth={2.25} />
        </span>
        {children}
      </div>
      {onDismiss ? (
        <IconButton
          label="Dismiss"
          onClick={onDismiss}
          // 44px on every pointer: it's small, and the toast is passing.
          className="relative m-1 self-start focus-ring-inset after:absolute after:left-1/2 after:top-1/2 after:size-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']"
        >
          <X />
        </IconButton>
      ) : null}
    </div>
  );
}
