import { useCallback, useRef, useState } from "react";
import { Check, ChevronDown, GitBranch } from "lucide-react";

import { BranchSelect } from "@/components/app/branch-select";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { AGENT_TYPE_LABELS, type CliAgentType } from "@/lib/agent-types";
import { useClickOutside } from "@/hooks/use-click-outside";
import { cn } from "@/lib/utils";

export function AgentTypeCombobox({
  value,
  onChange,
  agentTypes,
}: {
  value: CliAgentType;
  onChange: (value: CliAgentType) => void;
  agentTypes: CliAgentType[];
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const cmdRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(cmdRef, open, close);

  return (
    <div className="relative" ref={cmdRef}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (!open) setOpen(true);
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
                setOpen(false);
                requestAnimationFrame(() => triggerRef.current?.focus());
              }
            }}
          >
            <CommandList>
              <CommandGroup>
                {agentTypes.map((t) => (
                  <CommandItem
                    key={t}
                    value={t}
                    onSelect={() => {
                      onChange(t);
                      setOpen(false);
                      requestAnimationFrame(() => triggerRef.current?.focus());
                    }}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-3 w-3 shrink-0",
                        t === value ? "opacity-100" : "opacity-0"
                      )}
                    />
                    {AGENT_TYPE_LABELS[t]}
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

export function TemplateWorktreeOption({
  checked,
  cwd,
  baseBranch,
  branchName,
  onCheckedChange,
  onBaseBranchChange,
  onBranchNameChange,
}: {
  checked: boolean;
  cwd: string;
  baseBranch: string;
  branchName: string;
  onCheckedChange: (checked: boolean) => void;
  onBaseBranchChange: (value: string) => void;
  onBranchNameChange: (value: string) => void;
}): JSX.Element {
  return (
    <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
      <label className="flex cursor-pointer items-start gap-3">
        <Checkbox
          checked={checked}
          onCheckedChange={() => onCheckedChange(!checked)}
          className="mt-0.5"
          title="Toggle git worktree"
        />
        <span className="space-y-1">
          <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <GitBranch className="h-3.5 w-3.5" />
            Run in a git worktree
          </span>
          <span className="block text-xs text-muted-foreground">
            Creates an isolated worktree when this template is launched.
          </span>
        </span>
      </label>
      {checked ? (
        <div className="ml-8 w-[calc(100%-2rem)]">
          <BranchSelect
            cwd={cwd}
            baseBranch={baseBranch}
            onBaseBranchChange={onBaseBranchChange}
            worktreeBranch={branchName}
            onWorktreeBranchChange={onBranchNameChange}
            testIdPrefix="template-worktree"
          />
        </div>
      ) : null}
    </div>
  );
}

export function TemplateFullAccessOption({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
      <Checkbox
        checked={checked}
        onCheckedChange={() => onCheckedChange(!checked)}
        className="mt-0.5"
        title="Toggle full access"
      />
      <span className="space-y-1">
        <span className="block text-sm font-medium text-foreground">
          Start in full access mode
        </span>
        <span className="block text-xs text-muted-foreground">
          Starts the selected agent with its most permissive supported execution
          mode.
        </span>
      </span>
    </label>
  );
}
