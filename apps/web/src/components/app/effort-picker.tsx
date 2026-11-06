import { useState } from "react";
import type { AgentConfigChoice } from "@dispatch/shared";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { glassInset } from "@/lib/glass";
import { cn } from "@/lib/utils";

function Meter({
  index,
  count,
}: {
  index: number;
  count: number;
}): JSX.Element {
  return (
    <span aria-hidden="true" className="flex h-2 items-end gap-0.5">
      {Array.from({ length: count }, (_, step) => (
        <span
          key={step}
          className={cn(
            "w-1 rounded-[1px]",
            step <= index ? "bg-primary" : "bg-muted-foreground/25"
          )}
          style={{
            height: `${4 + (count > 1 ? (step / (count - 1)) * 4 : 4)}px`,
          }}
        />
      ))}
    </span>
  );
}

/** The same engine-owned choices and interaction in launch forms and the composer. */
export function EffortPicker({
  id,
  value,
  choices,
  onChange,
  onOpenChange,
  defaultLabel = "Default",
  allowDefault = true,
  description = "Higher levels spend more time thinking.",
  compact = false,
  disabled = false,
  pending = false,
  error,
}: {
  id: string;
  value: string | null;
  choices: readonly AgentConfigChoice[];
  onOpenChange?: (open: boolean) => void;
  onChange: (value: string | null) => void | Promise<unknown>;
  defaultLabel?: string;
  allowDefault?: boolean;
  description?: string;
  compact?: boolean;
  disabled?: boolean;
  pending?: boolean;
  error?: string;
}): JSX.Element {
  const [open, setIsOpen] = useState(false);
  const setOpen = (next: boolean) => {
    setIsOpen(next);
    onOpenChange?.(next);
  };
  const levels = choices.filter((choice) => choice.value !== "default");
  const selected = levels.findIndex((choice) => choice.value === value);
  const isDefault = value === null || value === "default";
  const label = isDefault ? "Default" : (levels[selected]?.name ?? value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          data-testid={id}
          disabled={disabled}
          aria-label={`Effort: ${isDefault ? defaultLabel : label}`}
          title={`Reasoning effort: ${isDefault ? defaultLabel : label}`}
          className={cn(
            "flex items-center justify-center rounded-md text-[11px] leading-tight transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            compact
              ? "h-6 max-w-32 shrink-0 gap-1.5 px-1.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground pointer-coarse:min-h-11"
              : [
                  glassInset,
                  "h-9 w-full flex-col gap-0.5 px-1 hover:bg-white/[0.1]",
                ]
          )}
        >
          {!isDefault && selected >= 0 ? (
            <Meter index={selected} count={levels.length} />
          ) : null}
          <span className="max-w-full truncate">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side={compact ? "top" : "bottom"}
        collisionPadding={12}
        className="w-64 max-w-[calc(100vw-1.5rem)] space-y-3 p-3"
        aria-label="Reasoning effort"
      >
        <div>
          <p className="text-sm font-medium">Reasoning effort</p>
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        </div>
        <ToggleGroup
          type="single"
          aria-label="Effort level"
          value={value ?? "default"}
          disabled={pending}
          className="grid w-full grid-cols-2 gap-1"
          onValueChange={(next) => {
            if (!next) return;
            void Promise.resolve(onChange(next === "default" ? null : next))
              .then(() => setOpen(false))
              .catch(() => {});
          }}
        >
          {allowDefault ? (
            <ToggleGroupItem
              value="default"
              className="col-span-2 h-9 text-xs"
              aria-label={defaultLabel}
            >
              {defaultLabel}
            </ToggleGroupItem>
          ) : null}
          {levels.map((choice, index) => (
            <ToggleGroupItem
              key={choice.value}
              value={choice.value}
              title={choice.description}
              aria-label={choice.name}
              className="h-11 min-w-0 flex-col text-xs"
            >
              <Meter index={index} count={levels.length} />
              <span className="max-w-full truncate">{choice.name}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {pending ? (
          <p className="text-xs text-muted-foreground">Applying…</p>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
