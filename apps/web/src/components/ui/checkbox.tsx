import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { type ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/utils";
import { touchTarget } from "./button";
import { useFieldControl } from "./field-context";

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
        "peer inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-xs border transition-colors",
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
