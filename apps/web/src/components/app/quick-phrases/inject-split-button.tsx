import { ChevronDown, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export function InjectSplitButton({
  disabled,
  isPending,
  onInject,
  size = "default",
  insidePopover = false,
}: {
  disabled: boolean;
  isPending: boolean;
  onInject: (submit: boolean) => void;
  size?: "sm" | "default";
  insidePopover?: boolean;
}) {
  const isSm = size === "sm";

  return (
    <div className={cn("flex items-stretch", isSm && "min-w-[5.5rem]")}>
      <Button
        type={isSm ? "button" : "submit"}
        size={isSm ? "sm" : "default"}
        disabled={disabled}
        className={cn("rounded-r-none", isSm && "h-7 gap-1 px-2 text-xs")}
        onClick={
          isSm
            ? (e: React.MouseEvent) => {
                e.preventDefault();
                onInject(true);
              }
            : undefined
        }
      >
        {isSm ? <Play className="h-2.5 w-2.5 fill-current" /> : null}
        {isPending ? "Sending…" : isSm ? "Send" : "Send & Submit"}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size={isSm ? "sm" : "default"}
            disabled={disabled}
            className={cn(
              "rounded-l-none border-l border-l-white/20 px-1.5",
              isSm && "h-7"
            )}
          >
            <ChevronDown className={cn(isSm ? "h-3 w-3" : "h-3.5 w-3.5")} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className={cn("min-w-[180px]", insidePopover && "z-[90]")}
        >
          <DropdownMenuItem
            className="text-foreground"
            onSelect={() => onInject(false)}
          >
            Paste without submitting
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
