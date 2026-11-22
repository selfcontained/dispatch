import * as React from "react";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { Hint } from "./tooltip";

const trackVariants = cva(
  "max-w-full rounded-md bg-fill-track p-0.5 ring-1 ring-inset ring-edge-subtle",
  {
    variants: {
      layout: {
        inline: "inline-flex h-8 items-stretch pointer-coarse:h-11",
        fill: "flex h-8 w-full items-stretch pointer-coarse:h-11",
        // An option grid, whose items carry more than a label.
        grid: "grid w-full grid-cols-2 gap-1",
      },
    },
    defaultVariants: {
      layout: "inline",
    },
  }
);

const itemVariants = cva(
  "relative inline-flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border border-transparent px-2 text-body-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-ring disabled-state data-[state=on]:border-edge data-[state=on]:bg-fill-raised data-[state=on]:text-foreground data-[state=on]:shadow-elev-control pointer-coarse:min-w-11 pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-1 pointer-coarse:after:content-[''] [&>svg]:size-icon-md [&>svg]:shrink-0",
  {
    variants: {
      layout: {
        inline: "",
        fill: "flex-1",
        grid: "min-h-11 flex-col gap-0.5 py-1",
      },
    },
    defaultVariants: {
      layout: "inline",
    },
  }
);

type Layout = VariantProps<typeof trackVariants>["layout"];

const LayoutContext = React.createContext<Layout>("inline");

type SegmentedControlProps<T extends string> = {
  value: T;
  onValueChange: (value: T) => void;
  "aria-label": string;
  "aria-describedby"?: string;
  "data-testid"?: string;
  layout?: Layout;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
};

/**
 * Switches the view of the same data, or makes a short either/or choice.
 * Exactly one option stays selected. Sections of a pane use Tabs.
 */
function SegmentedControl<T extends string>({
  value,
  onValueChange,
  layout = "inline",
  className,
  children,
  ...props
}: SegmentedControlProps<T>): JSX.Element {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      // A single toggle group's items are radios, so its root names the group.
      role="radiogroup"
      value={value}
      onValueChange={(next) => {
        // Radix reports "" when the selected item is pressed again.
        if (next) onValueChange(next as T);
      }}
      className={cn(trackVariants({ layout }), className)}
      {...props}
    >
      <LayoutContext.Provider value={layout}>{children}</LayoutContext.Provider>
    </ToggleGroupPrimitive.Root>
  );
}

const SegmentedControlItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  Omit<
    React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>,
    "asChild" | "title"
  > & {
    /** Explains the option on hover and focus. */
    hint?: React.ReactNode;
  }
>(({ className, hint, children, ...props }, ref) => {
  const layout = React.useContext(LayoutContext);
  return (
    <ToggleGroupPrimitive.Item
      ref={ref}
      asChild={!!hint}
      className={cn(itemVariants({ layout }), className)}
      {...props}
    >
      {hint ? (
        <Hint label={hint}>
          <button type="button">{children}</button>
        </Hint>
      ) : (
        children
      )}
    </ToggleGroupPrimitive.Item>
  );
});
SegmentedControlItem.displayName = "SegmentedControlItem";

export { SegmentedControl, SegmentedControlItem };
