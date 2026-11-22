import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { glassSurface } from "@/lib/glass";
import { cn } from "@/lib/utils";

/** The flat frame, which a SettingRow shares. */
export const panelFrame =
  "min-w-0 rounded-lg border border-border-subtle bg-surface-subtle";

/**
 * - `raised`: floats above the page. A thing with a title and content.
 * - `panel`: flat, groups a region: rows, a chart, a figure. It can sit in
 *   a raised card, never in another panel.
 * - `tone` tints either for a state.
 */
const cardVariants = cva("rounded-lg text-card-foreground", {
  variants: {
    variant: { raised: glassSurface, panel: panelFrame },
    tone: {
      neutral: "",
      accent: "border-primary/line bg-primary/wash",
      working: "border-status-working/line bg-status-working/tint",
      info: "border-info/line bg-info/tint",
      success: "border-success/line bg-success/tint",
      warning: "border-warning/line bg-warning/tint",
      danger: "border-danger/line bg-danger/wash",
    },
  },
  defaultVariants: { variant: "raised", tone: "neutral" },
});

export interface CardProps
  extends
    React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, variant, tone, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(cardVariants({ variant, tone }), className)}
      {...props}
    />
  )
);
Card.displayName = "Card";

/** A flat grouped region, padded. A list of rows takes `p-0`. */
const Panel = React.forwardRef<HTMLDivElement, Omit<CardProps, "variant">>(
  ({ className, ...props }, ref) => (
    <Card
      ref={ref}
      variant="panel"
      className={cn("p-3", className)}
      {...props}
    />
  )
);
Panel.displayName = "Panel";

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-1.5 p-4", className)}
    {...props}
  />
));
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h3 ref={ref} className={cn("text-heading-md", className)} {...props} />
));
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn("text-body-md text-muted-foreground", className)}
    {...props}
  />
));
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-4 pt-0", className)} {...props} />
));
CardContent.displayName = "CardContent";

export { Card, Panel, CardHeader, CardTitle, CardDescription, CardContent };
