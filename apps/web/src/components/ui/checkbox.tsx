import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { type ComponentPropsWithoutRef, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { touchTarget } from "./button";
import { useFieldControl } from "./field-context";

const box =
  "inline-flex shrink-0 items-center justify-center rounded-xs border transition-colors";
const checkedBox = "border-primary bg-primary text-primary-foreground";
const uncheckedBox = "border-edge bg-fill-inset";

/**
 * A checkbox that only reports: a task list's item. It is not a control, so
 * it can sit inside a row that is itself a button.
 */
export function CheckboxMark({
  checked,
  label,
  children,
  className,
}: {
  checked: boolean;
  label: string;
  /** Stands in for the empty box, for an item that is under way. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={label}
      data-checked={checked}
      className={cn(
        box,
        "size-4",
        checked ? checkedBox : uncheckedBox,
        className
      )}
    >
      {checked ? <Check className="size-icon-sm" /> : children}
    </span>
  );
}

export function Checkbox({
  className,
  ...rest
}: ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>) {
  const props = useFieldControl(rest);
  return (
    <CheckboxPrimitive.Root
      {...props}
      className={cn(
        // A disabled one's hit area would only block what is beside it.
        touchTarget,
        "focus-ring pointer-coarse:disabled:after:hidden",
        box,
        "peer h-5 w-5",
        "data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
        "data-[state=unchecked]:border-edge data-[state=unchecked]:bg-fill-inset",
        "disabled:cursor-not-allowed disabled-state disabled:pointer-events-auto",
        className
      )}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        <Check className="h-3.5 w-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
