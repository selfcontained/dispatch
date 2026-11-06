import { useState } from "react";
import type { Effort } from "@dispatch/shared";
import type { AgentType } from "@/lib/agent-types";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { glassInset } from "@/lib/glass";
import { EFFORT_LABELS } from "@/lib/agent-effort";
import { cn } from "@/lib/utils";

const LEVELS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

function EffortMeter({ value }: { value: Effort | null }): JSX.Element {
  const filled = value ? LEVELS.indexOf(value) + 1 : 0;
  return (
    <span aria-hidden="true" className="flex h-2 items-end gap-0.5">
      {LEVELS.map((level, index) => (
        <span
          key={level}
          className={cn(
            "w-1 rounded-[1px]",
            index < filled ? "bg-primary" : "bg-muted-foreground/25"
          )}
          style={{ height: `${4 + index}px` }}
        />
      ))}
    </span>
  );
}

export function AgentEffortSelect({
  value,
  onChange,
  agentType,
  id = "create-agent-effort",
  inheritLabel = "Default",
}: {
  value: Effort | null;
  onChange: (value: Effort | null) => void;
  agentType: AgentType;
  id?: string;
  inheritLabel?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const levels = agentType === "claude" ? LEVELS : LEVELS.slice(0, 4);
  const unsupported = agentType === "opencode";
  const label = unsupported ? "—" : value ? EFFORT_LABELS[value] : "Default";
  const fullLabel = value ? EFFORT_LABELS[value] : inheritLabel;
  return (
    <div className="space-y-1">
      <label className="text-sm text-muted-foreground" htmlFor={id}>
        Effort
      </label>
      <Popover open={open && !unsupported} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            id={id}
            data-testid={id}
            aria-label={`Effort: ${unsupported ? "Unavailable" : fullLabel}`}
            disabled={unsupported}
            title={
              unsupported
                ? "OpenCode does not support launch effort."
                : `Reasoning effort: ${fullLabel}`
            }
            className={cn(
              glassInset,
              "flex h-9 w-full flex-col items-center justify-center gap-0.5 rounded-md px-1 text-[11px] leading-tight transition-colors hover:bg-white/[0.1] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            )}
          >
            <EffortMeter value={unsupported ? null : value} />
            <span>{label}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          collisionPadding={12}
          className="w-64 max-w-[calc(100vw-1.5rem)] space-y-3 p-3"
          aria-label="Reasoning effort"
        >
          <div>
            <p className="text-sm font-medium">Reasoning effort</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Higher effort spends more time thinking.
            </p>
          </div>
          <ToggleGroup
            type="single"
            aria-label="Effort level"
            value={value ?? "default"}
            className="grid w-full grid-cols-2 gap-1"
            onValueChange={(next) => {
              if (!next) return;
              onChange(next === "default" ? null : (next as Effort));
              setOpen(false);
            }}
          >
            <ToggleGroupItem
              value="default"
              className="h-11 flex-col text-xs"
              aria-label={inheritLabel}
            >
              <EffortMeter value={null} />
              Default
            </ToggleGroupItem>
            {levels.map((level) => (
              <ToggleGroupItem
                key={level}
                value={level}
                className="h-11 flex-col text-xs"
                aria-label={EFFORT_LABELS[level]}
              >
                <EffortMeter value={level} />
                {EFFORT_LABELS[level]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <p className="text-xs text-muted-foreground">
            {inheritLabel === "Default"
              ? "Default uses the agent’s own settings."
              : `Default: ${inheritLabel}.`}
          </p>
        </PopoverContent>
      </Popover>
    </div>
  );
}
