import { type FormEvent } from "react";
import { Check, Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { WorktreeMode } from "@/components/app/types";

type CreateAgentDialogProps = {
  open: boolean;
  createName: string;
  createType: string;
  createCwd: string;
  createFullAccess: boolean;
  worktreeMode: WorktreeMode;
  worktreeLoading: boolean;
  worktreeSaving: boolean;
  worktreeError: string | null;
  worktreeRepoRoot: string | null;
  creating: boolean;
  setOpen: (open: boolean) => void;
  setCreateName: (name: string) => void;
  setCreateType: (value: string) => void;
  setCreateCwd: (cwd: string) => void;
  setWorktreeMode: (value: WorktreeMode) => void;
  setCreateFullAccess: (value: boolean | ((current: boolean) => boolean)) => void;
  refreshWorktreeMode: () => Promise<void>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
};

export function CreateAgentDialog({
  open,
  createName,
  createType,
  createCwd,
  createFullAccess,
  worktreeMode,
  worktreeLoading,
  worktreeSaving,
  worktreeError,
  worktreeRepoRoot,
  creating,
  setOpen,
  setCreateName,
  setCreateType,
  setCreateCwd,
  setWorktreeMode,
  setCreateFullAccess,
  refreshWorktreeMode,
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
              <option value="claude">Claude</option>
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-sm text-muted-foreground">Working directory</label>
            <Input
              value={createCwd}
              onChange={(event) => setCreateCwd(event.target.value)}
              onBlur={() => void refreshWorktreeMode()}
              placeholder="/absolute/path"
              required
            />
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <label className="text-sm text-muted-foreground">Repo worktree mode</label>
              <Button type="button" variant="ghost" size="sm" onClick={() => void refreshWorktreeMode()}>
                Reload
              </Button>
            </div>
            <select
              value={worktreeMode}
              onChange={(event) => setWorktreeMode(event.target.value as WorktreeMode)}
              className="flex h-9 w-full border border-input bg-background px-3 py-2 text-sm"
              disabled={worktreeLoading || worktreeSaving}
            >
              <option value="ask">On</option>
              <option value="auto">Auto</option>
              <option value="off">Off</option>
            </select>
            <p className="text-xs text-muted-foreground">
              {worktreeError
                ? worktreeError
                : worktreeRepoRoot
                  ? `Saved in ${worktreeRepoRoot}/.dispatch/config.json`
                  : "Enter a git working directory to persist this setting in the repo."}
            </p>
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
