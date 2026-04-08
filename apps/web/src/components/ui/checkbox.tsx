import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export function Checkbox({
  checked,
  onCheckedChange,
  className,
  title,
  "aria-label": ariaLabel,
  "data-testid": dataTestId,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  className?: string;
  title?: string;
  "aria-label"?: string;
  "data-testid"?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      tabIndex={0}
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onCheckedChange(!checked);
      }}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          if (!disabled) onCheckedChange(!checked);
        }
      }}
      className={cn(
        "inline-flex h-5 w-5 shrink-0 items-center justify-center border text-foreground transition-colors",
        checked
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-background",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
      title={title}
      data-testid={dataTestId}
    >
      {checked ? <Check className="h-3.5 w-3.5" /> : null}
    </button>
  );
}
