import { type FormEvent, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AGENT_TYPE_LABELS, type AgentType } from "@/lib/agent-types";
import { cn } from "@/lib/utils";

type CreateAgentDialogProps = {
  open: boolean;
  createName: string;
  createType: AgentType;
  createCwd: string;
  createFullAccess: boolean;
  creating: boolean;
  cwdHistory: string[];
  enabledAgentTypes: AgentType[];
  setOpen: (open: boolean) => void;
  setCreateName: (name: string) => void;
  setCreateType: (value: AgentType) => void;
  setCreateCwd: (cwd: string) => void;
  setCreateFullAccess: (value: boolean | ((current: boolean) => boolean)) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
};

export function CreateAgentDialog({
  open,
  createName,
  createType,
  createCwd,
  createFullAccess,
  creating,
  cwdHistory,
  enabledAgentTypes,
  setOpen,
  setCreateName,
  setCreateType,
  setCreateCwd,
  setCreateFullAccess,
  onSubmit
}: CreateAgentDialogProps): JSX.Element {
  const [cwdDropdownOpen, setCwdDropdownOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const sortedCwdHistory = [...cwdHistory].sort((left, right) => left.localeCompare(right));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Agent</DialogTitle>
          <DialogDescription>Name, type, and working directory for a new agent session.</DialogDescription>
        </DialogHeader>

        <form data-testid="create-agent-form" className="space-y-3" onSubmit={(event) => void onSubmit(event)}>
          <div className="space-y-1">
            <label className="text-sm text-muted-foreground">Name</label>
            <Input
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
              placeholder="agent name (optional)"
              data-testid="create-agent-name"
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm text-muted-foreground">Type</label>
            <Select value={createType} onValueChange={(value) => setCreateType(value as AgentType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {enabledAgentTypes.map((agentType) => (
                  <SelectItem key={agentType} value={agentType}>
                    {AGENT_TYPE_LABELS[agentType]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="relative space-y-1">
            <label className="text-sm text-muted-foreground">Working directory</label>
            <div className="relative">
              <Input
                ref={inputRef}
                value={createCwd}
                onChange={(event) => {
                  setCreateCwd(event.target.value);
                  if (cwdHistory.length > 0) {
                    setCwdDropdownOpen(true);
                  }
                }}
                onFocus={() => {
                  if (cwdHistory.length > 0) {
                    setCwdDropdownOpen(true);
                  }
                }}
                onBlur={() => {
                  // Delay closing so click on dropdown item registers first
                  setTimeout(() => setCwdDropdownOpen(false), 150);
                }}
                placeholder="~/path/to/project"
                required
                data-testid="create-agent-cwd"
                className="pr-8"
              />
              {cwdHistory.length > 0 ? (
                <button
                  type="button"
                  tabIndex={-1}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    setCwdDropdownOpen((prev) => !prev);
                    inputRef.current?.focus();
                  }}
                >
                  <ChevronDown className={cn("h-4 w-4 transition-transform", cwdDropdownOpen && "rotate-180")} />
                </button>
              ) : null}
            </div>
            {cwdDropdownOpen && sortedCwdHistory.length > 0 ? (
              <div
                className="absolute left-0 right-0 z-10 mt-1 max-h-[160px] overflow-y-auto rounded-md border border-border bg-background shadow-md"
                data-testid="create-agent-cwd-history"
              >
                <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Recent directories</div>
                {sortedCwdHistory.map((dir) => (
                  <button
                    key={dir}
                    type="button"
                    data-testid="create-agent-cwd-history-option"
                    className="w-full truncate px-2 py-1.5 text-left font-mono text-xs text-foreground hover:bg-muted/70"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      setCreateCwd(dir);
                      setCwdDropdownOpen(false);
                    }}
                  >
                    {dir}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
            <button
              type="button"
              role="checkbox"
              aria-checked={createFullAccess}
              onClick={() => setCreateFullAccess((current) => !current)}
              className={cn(
                "mt-0.5 inline-flex h-5 w-5 items-center justify-center border text-foreground transition-colors",
                createFullAccess ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background"
              )}
              title="Toggle full access"
            >
              {createFullAccess ? <Check className="h-3.5 w-3.5" /> : null}
            </button>
            <span className="space-y-1">
              <span className="block text-sm font-medium text-foreground">Start in full access mode</span>
              <span className="block text-xs text-muted-foreground">
                Starts the selected agent with its most permissive supported execution mode.
              </span>
            </span>
          </label>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} data-testid="create-agent-cancel">
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={creating} data-testid="create-agent-submit">
              {creating ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />}
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
