import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type DeleteAgentDialogProps = {
  open: boolean;
  deleteTarget: Agent | null;
  setOpen: (open: boolean) => void;
  setDeleteTarget: (agent: Agent | null) => void;
  onDelete: (agent: Agent) => Promise<void>;
};

export function DeleteAgentDialog({
  open,
  deleteTarget,
  setOpen,
  setDeleteTarget,
  onDelete
}: DeleteAgentDialogProps): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete Agent</DialogTitle>
          <DialogDescription>
            {deleteTarget
              ? `Delete "${deleteTarget.name}"? This permanently removes the agent record and all media files.`
              : "Delete this agent?"}
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              setOpen(false);
              setDeleteTarget(null);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={async () => {
              if (!deleteTarget) {
                return;
              }
              await onDelete(deleteTarget);
              setOpen(false);
              setDeleteTarget(null);
            }}
          >
            Delete
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
