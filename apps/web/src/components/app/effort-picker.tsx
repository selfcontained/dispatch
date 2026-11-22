import { useState } from "react";
import type { AgentConfigChoice } from "@dispatch/shared";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { Hint } from "@/components/ui/tooltip";
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
            "w-1 rounded-mark",
            step <= index ? "bg-primary" : "bg-muted-foreground/tint-strong"
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
        <Hint label={`Reasoning effort: ${isDefault ? defaultLabel : label}`}>
          <Button
            type="button"
            id={id}
            data-testid={id}
            disabled={disabled}
            aria-label={`Effort: ${isDefault ? defaultLabel : label}`}
            variant={compact ? "ghost" : "field"}
            size={compact ? "stream-meta" : "md"}
            className={cn(
              "text-label-sm leading-tight disabled:pointer-events-auto",
              compact
                ? "max-w-32 shrink-0"
                : "w-full flex-col justify-center gap-0.5"
            )}
          >
            {!isDefault && selected >= 0 ? (
              <Meter index={selected} count={levels.length} />
            ) : null}
            <span className="max-w-full truncate">{label}</span>
          </Button>
        </Hint>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side={compact ? "top" : "bottom"}
        collisionPadding={12}
        className="w-64 max-w-[calc(100vw-1.5rem)] space-y-3 p-3"
        aria-label="Reasoning effort"
      >
        <div>
          <p className="text-body-md font-medium">Reasoning effort</p>
          <p className="mt-1 text-body-sm text-muted-foreground">
            {description}
          </p>
        </div>
        <SegmentedControl
          layout="grid"
          aria-label="Effort level"
          value={value ?? "default"}
          disabled={pending}
          onValueChange={(next) => {
            void Promise.resolve(onChange(next === "default" ? null : next))
              .then(() => setOpen(false))
              .catch(() => {});
          }}
        >
          {allowDefault ? (
            <SegmentedControlItem
              value="default"
              className="col-span-2"
              aria-label={defaultLabel}
            >
              {defaultLabel}
            </SegmentedControlItem>
          ) : null}
          {levels.map((choice, index) => (
            <SegmentedControlItem
              key={choice.value}
              hint={choice.description}
              value={choice.value}
              aria-label={choice.name}
            >
              <Meter index={index} count={levels.length} />
              <span className="max-w-full truncate">{choice.name}</span>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        {pending ? (
          <p className="text-body-sm text-muted-foreground">Applying…</p>
        ) : null}
        {error ? (
          <p role="alert" className="text-body-sm text-danger">
            {error}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
