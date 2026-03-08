import { type FormEvent } from "react";
import { Check, Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type CreateAgentDialogProps = {
  open: boolean;
  createName: string;
  createType: string;
  createCwd: string;
  createFullAccess: boolean;
  creating: boolean;
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
  setOpen,
  setCreateName,
  setCreateType,
  setCreateCwd,
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

        <form className="space-y-3" onSubmit={(event) => void onSubmit(event)}>
          <div className="space-y-1">
            <label className="text-sm text-muted-foreground">Name</label>
            <Input
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
              placeholder="agent name (optional)"
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm text-muted-foreground">Type</label>
            <select
              value={createType}
              onChange={(event) => setCreateType(event.target.value)}
              className="flex h-9 w-full border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="codex">Codex</option>
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-sm text-muted-foreground">Working directory</label>
            <Input
              value={createCwd}
              onChange={(event) => setCreateCwd(event.target.value)}
              placeholder="/absolute/path"
              required
            />
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
                Starts Codex with sandboxing and approval prompts disabled.
              </span>
            </span>
          </label>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={creating}>
              {creating ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />}
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
