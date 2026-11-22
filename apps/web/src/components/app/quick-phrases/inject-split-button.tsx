import { Play } from "lucide-react";

import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { SplitButton } from "@/components/ui/split-button";
import { cn } from "@/lib/utils";

export function InjectSplitButton({
  disabled,
  onInject,
  size = "default",
  insidePopover = false,
}: {
  disabled: boolean;
  onInject: (submit: boolean) => void;
  size?: "sm" | "default";
  insidePopover?: boolean;
}) {
  const isSm = size === "sm";
  const label = isSm ? "Send" : "Send & Submit";

  return (
    <SplitButton
      type={isSm ? "button" : "submit"}
      size={isSm ? "xs" : "md"}
      disabled={disabled}
      menuLabel="More ways to send"
      menuProps={{
        className: cn("min-w-[180px]", insidePopover && "z-tooltip"),
      }}
      menu={
        <DropdownMenuItem
          className="text-foreground"
          onSelect={() => onInject(false)}
        >
          Paste without submitting
        </DropdownMenuItem>
      }
      className={cn(isSm && "min-w-16")}
      onClick={
        isSm
          ? (e: React.MouseEvent) => {
              e.preventDefault();
              onInject(true);
            }
          : undefined
      }
    >
      {isSm ? <Play className="fill-current" /> : null}
      {label}
    </SplitButton>
  );
}
