import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const blockShellVariants = cva("min-w-0 max-w-full", {
  variants: {
    level: {
      // Words and lists, which read as part of the post.
      plain: "",
      // A thing the post hands over: metric, chart, file, resource, code, task.
      card: "overflow-hidden rounded-lg border border-border-subtle bg-surface-subtle",
      // Something with a state someone acts on. The bar carries the state.
      ask: "overflow-hidden rounded-lg border border-l-2 border-border-subtle bg-surface-subtle",
    },
    state: {
      waiting: "border-l-info",
      closed: "border-l-border",
      changes: "border-l-danger",
      approved: "border-l-success",
    },
    /** False where the content is the click target or runs to the edges. */
    padded: { true: "", false: "" },
  },
  compoundVariants: [{ level: ["card", "ask"], padded: true, class: "p-3" }],
  defaultVariants: {
    level: "card",
    padded: true,
  },
});

type Variants = VariantProps<typeof blockShellVariants>;

export type BlockShellState = NonNullable<Variants["state"]>;

type BlockShellProps = React.HTMLAttributes<HTMLDivElement> & {
  asChild?: boolean;
  padded?: boolean;
} & (
    | { level?: "plain" | "card"; state?: never }
    | { level: "ask"; state: BlockShellState }
  );

/** The one frame for a block in a stream. */
const BlockShell = React.forwardRef<HTMLDivElement, BlockShellProps>(
  (
    { asChild, level = "card", state, padded = true, className, ...props },
    ref
  ) => {
    const Comp = asChild ? Slot : "div";
    return (
      <Comp
        ref={ref}
        data-block-shell={level}
        data-block-state={state}
        className={cn(blockShellVariants({ level, state, padded }), className)}
        {...props}
      />
    );
  }
);
BlockShell.displayName = "BlockShell";

const BlockHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-block-part="header"
    className={cn(
      "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1",
      className
    )}
    {...props}
  />
));
BlockHeader.displayName = "BlockHeader";

const BlockBody = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-block-part="body"
    className={cn("min-w-0", className)}
    {...props}
  />
));
BlockBody.displayName = "BlockBody";

const BlockFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-block-part="footer"
    className={cn("mt-3 flex min-w-0 flex-wrap items-center gap-2", className)}
    {...props}
  />
));
BlockFooter.displayName = "BlockFooter";

export { BlockShell, BlockHeader, BlockBody, BlockFooter };
