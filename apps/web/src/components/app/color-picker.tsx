import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const PROJECT_COLORS = [
  "#9575ed",
  "#38b7a0",
  "#dda348",
  "#e17b9a",
  "#649feb",
  "#ef6c57",
  "#74b85c",
  "#a5aab7",
];
export const isHexColor = (value: string) => /^#[0-9a-fA-F]{6}$/.test(value);
/** Compact shared project/label palette; keeps custom colors one edit away. */
export function ColorPicker({
  value,
  onChange,
  disabled = false,
  label = "Color",
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const valid = isHexColor(value);
  return (
    <div className="space-y-1.5" role="group" aria-label={label}>
      <div className="flex flex-wrap gap-0.5">
        {PROJECT_COLORS.map((color) => (
          <Button
            type="button"
            key={color}
            variant="ghost"
            disabled={disabled}
            aria-label={`Color ${color}`}
            aria-pressed={value.toLowerCase() === color}
            title={color}
            className="h-7 w-7 shrink-0 rounded-full p-1"
            onClick={() => onChange(color)}
          >
            <span
              className="flex h-5 w-5 items-center justify-center rounded-full border border-black/10 text-black"
              style={{ backgroundColor: color }}
            >
              {value.toLowerCase() === color && <Check className="h-3 w-3" />}
            </span>
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <Input
          type="color"
          disabled={disabled}
          aria-label={`Choose custom ${label.toLowerCase()}`}
          value={valid ? value : PROJECT_COLORS[0]}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-7 shrink-0 cursor-pointer rounded-full border-0 bg-transparent p-1 shadow-none [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-full [&::-webkit-color-swatch]:border-0 [&::-moz-color-swatch]:rounded-full [&::-moz-color-swatch]:border-0"
        />
        <Input
          disabled={disabled}
          aria-label={`${label} hex`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          pattern="#[0-9a-fA-F]{6}"
          maxLength={7}
          className="h-7 w-24 px-2 font-mono text-xs"
          aria-invalid={!valid}
        />
      </div>
    </div>
  );
}
