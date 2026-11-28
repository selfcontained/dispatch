import * as React from "react";
import { Loader2 } from "lucide-react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { Spinner } from "./spinner";

// An invisible 44px target, for the controls too small to grow on touch.
export const touchTarget =
  "relative pointer-coarse:after:absolute pointer-coarse:after:left-1/2 pointer-coarse:after:top-1/2 pointer-coarse:after:size-11 pointer-coarse:after:-translate-x-1/2 pointer-coarse:after:-translate-y-1/2 pointer-coarse:after:content-['']";

const textSize =
  "gap-1.5 [&>svg]:size-icon-md pointer-coarse:min-h-11 pointer-coarse:min-w-11";
const iconSize = "shrink-0 p-0";

// Each size owns height, padding, type, icon and touch target. Call sites
// choose a size and never restate those (`dispatch/controls` lint rule).
const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md font-medium transition-colors focus-ring disabled-state [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        primary:
          "bg-primary/soft text-primary-foreground backdrop-blur-md border border-edge-on-color shadow-elev-primary hover:bg-primary/dense hover:shadow-elev-primary-hover",
        secondary:
          "border border-edge bg-fill-raised text-foreground backdrop-blur-md shadow-elev-control hover:bg-fill-hover hover:border-edge-strong",
        ghost:
          "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
        // Opens a picker, so it reads as the inputs it sits among.
        field:
          "justify-between border border-edge bg-fill-inset font-normal text-foreground shadow-elev-inset backdrop-blur-md hover:bg-fill-hover",
        danger: "bg-danger text-danger-foreground hover:bg-danger/dense",
        link: "text-inherit underline underline-offset-2 hover:no-underline",
      },
      /** Colours a ghost button. */
      tone: {
        neutral: "",
        primary: "",
        success: "",
        warning: "",
        danger: "",
        info: "",
      },
      size: {
        xs: cn(textSize, "h-7 px-2 text-body-sm"),
        sm: cn(textSize, "h-8 px-2 text-body-md"),
        md: cn(textSize, "h-9 px-3 text-body-md"),
        "icon-xs": cn(iconSize, touchTarget, "size-6 [&>svg]:size-icon-sm"),
        "icon-sm": cn(
          iconSize,
          "size-7 [&>svg]:size-icon-md pointer-coarse:size-11"
        ),
        "icon-md": cn(
          iconSize,
          "size-8 [&>svg]:size-icon-lg pointer-coarse:size-11"
        ),
        // Runs with the text around it and takes that text's size.
        // Its hit area grows 4px up and down, no further: 44px would take
        // the taps meant for the lines and controls around it.
        inline:
          "relative h-auto gap-1 rounded-sm p-0 font-normal [&>svg]:size-icon-sm pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-1 pointer-coarse:after:content-['']",
      },
      /** Lets a long label wrap; the size becomes the minimum height. */
      wrap: {
        true: "h-auto min-w-0 whitespace-normal py-1 text-center",
        false: "",
      },
    },
    compoundVariants: [
      { wrap: true, size: "xs", class: "min-h-7" },
      { wrap: true, size: "sm", class: "min-h-8" },
      { wrap: true, size: "md", class: "min-h-9" },
      {
        variant: "ghost",
        tone: "primary",
        class: "text-primary hover:bg-primary/tint-strong hover:text-primary",
      },
      {
        variant: "ghost",
        tone: "success",
        class: "text-success hover:bg-success/tint-strong hover:text-success",
      },
      {
        variant: "ghost",
        tone: "warning",
        class: "text-warning hover:bg-warning/tint-strong hover:text-warning",
      },
      {
        variant: "ghost",
        tone: "danger",
        class: "text-danger hover:bg-danger/tint-strong hover:text-danger",
      },
      {
        variant: "ghost",
        tone: "info",
        class: "text-info hover:bg-info/tint-strong hover:text-info",
      },
    ],
    defaultVariants: {
      variant: "secondary",
      size: "md",
    },
  }
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** A toggle's state: sets `aria-pressed` and draws the selected fill. */
  pressed?: boolean;
  /**
   * Its request is in flight: disabled, with a spinner over the label, so
   * the width and the accessible name hold.
   */
  pending?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      tone,
      size,
      wrap,
      pressed,
      pending,
      disabled,
      asChild = false,
      children,
      ...props
    },
    ref
  ) => {
    const Comp = asChild ? Slot : "button";
    const spinning = Boolean(pending) && !asChild;
    const spinner = spinning ? (
      <span
        data-spinner=""
        className={cn(
          "absolute inset-0 flex items-center justify-center",
          variant === "primary"
            ? "text-primary-foreground"
            : variant === "danger"
              ? "text-danger-foreground"
              : "text-foreground"
        )}
      >
        <Spinner />
      </span>
    ) : null;
    return (
      <Comp
        className={cn(
          buttonVariants({ variant, tone, size, wrap }),
          pressed &&
            "bg-surface-selected text-primary hover:bg-surface-selected hover:text-primary",
          className,
          // Hidden with colour, not visibility, which would take it out of
          // the button's accessible name.
          spinning &&
            "relative text-transparent [&>:not([data-spinner])]:opacity-0"
        )}
        ref={ref}
        aria-pressed={pressed}
        aria-busy={spinning || undefined}
        disabled={disabled || spinning}
        {...props}
      >
        {asChild ? (
          children
        ) : (
          <>
            {children}
            {spinner}
          </>
        )}
      </Comp>
    );
  }
);
Button.displayName = "Button";

function LoadingButton({
  loading,
  disabled,
  children,
  ...props
}: Omit<ButtonProps, "asChild"> & { loading: boolean }) {
  return (
    <Button
      {...props}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading && (
        <Loader2
          className="mr-1.5 size-3.5 shrink-0 animate-spin"
          aria-hidden="true"
        />
      )}
      {children}
    </Button>
  );
}

export { Button, LoadingButton };
