import { type Agent, type WorktreeMode } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type EditWorktreeModeDialogProps = {
  open: boolean;
  target: Agent | null;
  mode: WorktreeMode;
  loading: boolean;
  saving: boolean;
  error: string | null;
  setOpen: (open: boolean) => void;
  setMode: (mode: WorktreeMode) => void;
  onSave: () => Promise<void>;
};

export function EditWorktreeModeDialog({
  open,
  target,
  mode,
  loading,
  saving,
  error,
  setOpen,
  setMode,
  onSave
}: EditWorktreeModeDialogProps): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Worktree Mode</DialogTitle>
          <DialogDescription>
            {target ? `Configure worktree behavior for "${target.name}".` : "Configure worktree behavior."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1">
            <label className="text-sm text-muted-foreground">Worktree mode</label>
            <select
              value={mode}
              onChange={(event) => setMode(event.target.value as WorktreeMode)}
              className="flex h-9 w-full border border-input bg-background px-3 py-2 text-sm"
              disabled={loading || saving}
            >
              <option value="ask">On</option>
              <option value="auto">Auto</option>
              <option value="off">Off</option>
            </select>
            <p className="text-xs text-muted-foreground">
              {error ?? "On: prompt each time. Auto: create automatically. Off: disable worktrees."}
            </p>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void onSave()} disabled={loading || saving || !target}>
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
