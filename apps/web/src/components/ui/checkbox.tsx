import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { type ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/utils";

export function Checkbox({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      {...props}
      className={cn(
        "peer inline-flex h-5 w-5 shrink-0 items-center justify-center border transition-colors",
        "data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
        "data-[state=unchecked]:border-border data-[state=unchecked]:bg-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        <Check className="h-3.5 w-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
