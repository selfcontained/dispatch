import { useCallback, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useClickOutside } from "@/hooks/use-click-outside";
import {
  AGENT_TYPE_LABELS,
  type AgentType,
  sortAgentTypes,
} from "@/lib/agent-types";
import { cn } from "@/lib/utils";

type AgentTypeSelectProps = {
  value: AgentType;
  onChange: (type: AgentType) => void;
  agentTypes: AgentType[];
  onOpenChange?: (open: boolean) => void;
  label?: string;
};

export function AgentTypeSelect({
  value,
  onChange,
  agentTypes,
  onOpenChange,
  label = "Type",
}: AgentTypeSelectProps): JSX.Element {
  const sortedTypes = useMemo(() => sortAgentTypes(agentTypes), [agentTypes]);
  const [open, setOpen] = useState(false);
  const cmdRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const updateOpen = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange]
  );

  const closeDropdown = useCallback(() => updateOpen(false), [updateOpen]);
  useClickOutside(cmdRef, open, closeDropdown);

  return (
    <div className="relative space-y-1" ref={cmdRef}>
      <label className="text-sm text-muted-foreground">{label}</label>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => updateOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (!open) updateOpen(true);
          }
        }}
        className={cn(
          "flex h-9 w-full items-center justify-between rounded-md border border-white/[0.12] bg-white/[0.04] px-3 py-2 text-sm shadow-[inset_0_2px_6px_rgba(0,0,0,0.3)] backdrop-blur-md",
          "ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring"
        )}
      >
        {AGENT_TYPE_LABELS[value]}
        <ChevronDown
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform",
            open && "rotate-180"
          )}
        />
      </button>
      {open ? (
        <div className="absolute left-0 right-0 z-[80] mt-1 rounded-md border border-white/[0.2] bg-[hsl(var(--card))] shadow-[0_16px_64px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-2xl">
          <Command
            shouldFilter={false}
            ref={(el) => {
              if (el) requestAnimationFrame(() => el.focus());
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                updateOpen(false);
                requestAnimationFrame(() => triggerRef.current?.focus());
              }
            }}
          >
            <CommandList>
              <CommandGroup>
                {sortedTypes.map((agentType) => (
                  <CommandItem
                    key={agentType}
                    value={agentType}
                    onSelect={() => {
                      onChange(agentType);
                      updateOpen(false);
                      requestAnimationFrame(() => triggerRef.current?.focus());
                    }}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-3 w-3 shrink-0",
                        agentType === value ? "opacity-100" : "opacity-0"
                      )}
                    />
                    {AGENT_TYPE_LABELS[agentType]}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      ) : null}
    </div>
  );
}
