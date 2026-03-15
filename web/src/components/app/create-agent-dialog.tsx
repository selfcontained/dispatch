import { type FormEvent } from "react";
import { Check, FolderOpen, Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

type CreateAgentDialogProps = {
  open: boolean;
  createName: string;
  createType: string;
  createCwd: string;
  createDirectoryPicking: boolean;
  createFullAccess: boolean;
  creating: boolean;
  setOpen: (open: boolean) => void;
  setCreateName: (name: string) => void;
  setCreateType: (value: string) => void;
  setCreateCwd: (cwd: string) => void;
  onPickCreateDirectory: () => Promise<void>;
  setCreateFullAccess: (value: boolean | ((current: boolean) => boolean)) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
};

export function CreateAgentDialog({
  open,
  createName,
  createType,
  createCwd,
  createDirectoryPicking,
  createFullAccess,
  creating,
  setOpen,
  setCreateName,
  setCreateType,
  setCreateCwd,
  onPickCreateDirectory,
  setCreateFullAccess,
  onSubmit
}: CreateAgentDialogProps): JSX.Element {
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
            <div className="flex items-center gap-2">
              <Input
                value={createCwd}
                onChange={(event) => setCreateCwd(event.target.value)}
                placeholder="/absolute/path"
                required
                data-testid="create-agent-cwd"
              />
              <Button
                type="button"
                variant="ghost"
                onClick={() => void onPickCreateDirectory()}
                disabled={createDirectoryPicking}
                data-testid="create-agent-browse"
              >
                {createDirectoryPicking ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <FolderOpen className="mr-1.5 h-4 w-4" />
                )}
                Browse
              </Button>
            </div>
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
