import * as React from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

import { Button, type ButtonProps } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { Hint } from "./tooltip";

export interface SplitButtonProps extends Omit<
  ButtonProps,
  "size" | "title" | "wrap"
> {
  size?: "xs" | "sm" | "md";
  /** The menu's items. Without them this is a plain Button. */
  menu?: React.ReactNode;
  /** Names the chevron half. */
  menuLabel: string;
  menuTestId?: string;
  menuProps?: React.ComponentPropsWithoutRef<typeof DropdownMenuContent>;
  menuDisabled?: boolean;
  /** Explains the main action, or why it is unavailable. */
  hint?: React.ReactNode;
}

// Each half drawn with its own shadow casts it across the seam onto the
// other's translucent fill. The pair shares one shadow on the wrapper instead.
const halfShadow = "shadow-none hover:shadow-none";

function wrapperShadow(
  variant: ButtonProps["variant"],
  disabled: boolean | undefined
) {
  if (variant === "primary") {
    return cn(
      "shadow-elev-primary",
      !disabled && "hover:shadow-elev-primary-hover"
    );
  }
  if (variant === "secondary") return "shadow-elev-control";
  return undefined;
}

/** A primary action and a menu of its variations, drawn as one control. */
const SplitButton = React.forwardRef<HTMLButtonElement, SplitButtonProps>(
  (
    {
      menu,
      menuLabel,
      menuTestId,
      menuProps,
      menuDisabled,
      hint,
      className,
      variant = "secondary",
      tone,
      size = "md",
      type = "button",
      asChild,
      disabled,
      ...props
    },
    ref
  ) => {
    const main = (
      <Hint label={hint}>
        <Button
          ref={ref}
          type={asChild ? undefined : type}
          asChild={asChild}
          variant={variant}
          tone={tone}
          size={size}
          disabled={disabled}
          className={cn(
            "min-w-0",
            !!hint && "disabled:pointer-events-auto",
            !!menu && cn("rounded-r-none border-r-0", halfShadow),
            className
          )}
          {...props}
        />
      </Hint>
    );
    if (!menu) return main;
    return (
      <div
        className={cn(
          "inline-flex min-w-0 max-w-full items-stretch rounded-md",
          wrapperShadow(variant, disabled)
        )}
      >
        {main}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Hint label={menuLabel}>
              <Button
                type="button"
                variant={variant}
                tone={tone}
                size={size}
                disabled={menuDisabled ?? disabled}
                aria-label={menuLabel}
                data-testid={menuTestId}
                className={cn(
                  "w-7 shrink-0 rounded-l-none border-l px-0",
                  halfShadow,
                  variant === "primary"
                    ? "border-l-primary-foreground/tint-strong"
                    : "border-l-edge"
                )}
              >
                <ChevronDown aria-hidden="true" />
              </Button>
            </Hint>
          </DropdownMenuTrigger>
          <DropdownMenuContent loop align="end" {...menuProps}>
            {menu}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }
);
SplitButton.displayName = "SplitButton";

export { SplitButton };
