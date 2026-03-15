import { type FormEvent, useRef, useState } from "react";
import { Check, ChevronsUpDown, Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

type CreateAgentDialogProps = {
  open: boolean;
  createName: string;
  createType: string;
  createCwd: string;
  createFullAccess: boolean;
  creating: boolean;
  cwdHistory: string[];
  setOpen: (open: boolean) => void;
  setCreateName: (name: string) => void;
  setCreateType: (value: string) => void;
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
  setOpen,
  setCreateName,
  setCreateType,
  setCreateCwd,
  setCreateFullAccess,
  onSubmit
}: CreateAgentDialogProps): JSX.Element {
  const [cwdPopoverOpen, setCwdPopoverOpen] = useState(false);
  const [cwdSearch, setCwdSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const handlePopoverOpenChange = (nextOpen: boolean) => {
    setCwdPopoverOpen(nextOpen);
    if (nextOpen) {
      setCwdSearch("");
    }
  };

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
            <Select value={createType} onValueChange={setCreateType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="codex">Codex</SelectItem>
                <SelectItem value="claude">Claude</SelectItem>
                <SelectItem value="opencode">OpenCode</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-sm text-muted-foreground">Working directory</label>
            {cwdHistory.length > 0 ? (
              <Popover open={cwdPopoverOpen} onOpenChange={handlePopoverOpenChange}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="default"
                    role="combobox"
                    aria-expanded={cwdPopoverOpen}
                    className="w-full justify-between font-mono text-sm"
                    data-testid="create-agent-cwd"
                  >
                    <span className="truncate">{createCwd || "~/path/to/project"}</span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="p-0">
                  <Command shouldFilter={false}>
                    <CommandInput
                      ref={searchRef}
                      placeholder="Type a path or pick from history..."
                      value={cwdSearch}
                      onValueChange={setCwdSearch}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && cwdSearch.trim()) {
                          event.preventDefault();
                          setCreateCwd(cwdSearch.trim());
                          setCwdPopoverOpen(false);
                        }
                      }}
                    />
                    <CommandList>
                      <CommandGroup heading="Recent directories">
                        {cwdHistory
                          .filter((dir) => !cwdSearch || dir.toLowerCase().includes(cwdSearch.toLowerCase()))
                          .map((dir) => (
                            <CommandItem
                              key={dir}
                              value={dir}
                              onSelect={(value) => {
                                setCreateCwd(value);
                                setCwdPopoverOpen(false);
                              }}
                            >
                              <span className="truncate font-mono text-xs">{dir}</span>
                            </CommandItem>
                          ))}
                      </CommandGroup>
                      {cwdSearch.trim() && !cwdHistory.some((dir) => dir === cwdSearch.trim()) ? (
                        <CommandGroup>
                          <CommandItem
                            value={cwdSearch.trim()}
                            onSelect={(value) => {
                              setCreateCwd(value);
                              setCwdPopoverOpen(false);
                            }}
                          >
                            <span className="font-mono text-xs">Use "{cwdSearch.trim()}"</span>
                          </CommandItem>
                        </CommandGroup>
                      ) : null}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            ) : (
              <Input
                value={createCwd}
                onChange={(event) => setCreateCwd(event.target.value)}
                placeholder="~/path/to/project"
                required
                data-testid="create-agent-cwd"
              />
            )}
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
