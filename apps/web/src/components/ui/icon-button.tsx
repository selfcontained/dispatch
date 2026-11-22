import * as React from "react";

import { Button, type ButtonProps } from "./button";
import { Hint, type HintProps } from "./tooltip";

export interface IconButtonProps extends Omit<ButtonProps, "size" | "title"> {
  /** The accessible name, and the tooltip unless `tooltip` says more. */
  label: string;
  tooltip?: React.ReactNode;
  side?: HintProps["side"];
  size?: "icon-xs" | "icon-sm" | "icon-md";
}

const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      label,
      tooltip,
      side,
      size = "icon-md",
      variant = "ghost",
      type = "button",
      asChild,
      ...props
    },
    ref
  ) => (
    <Hint label={tooltip ?? label} side={side}>
      <Button
        ref={ref}
        // A slotted child keeps its own element's type (a link has none).
        type={asChild ? undefined : type}
        asChild={asChild}
        size={size}
        variant={variant}
        aria-label={label}
        {...props}
      />
    </Hint>
  )
);
IconButton.displayName = "IconButton";

export { IconButton };
