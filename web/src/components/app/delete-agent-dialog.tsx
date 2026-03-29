import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Archive, GitBranch, Loader2 } from "lucide-react";

import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";

type WorktreeStatus = {
  hasWorktree: boolean;
  hasUnmergedCommits: boolean;
  hasUncommittedChanges: boolean;
  worktreePath: string | null;
  branchName: string | null;
  changedFiles: string[];
  uncommittedFiles: string[];
};

type DeleteStep = "confirm" | "worktree-choice";

type DeleteAgentDialogProps = {
  open: boolean;
  deleteTarget: Agent | null;
  setOpen: (open: boolean) => void;
  setDeleteTarget: (agent: Agent | null) => void;
  onDelete: (agent: Agent, cleanupWorktree?: string) => Promise<void>;
};

export function DeleteAgentDialog({
  open,
  deleteTarget,
  setOpen,
  setDeleteTarget,
  onDelete
}: DeleteAgentDialogProps): JSX.Element {
  const [step, setStep] = useState<DeleteStep>("confirm");
  const [worktreeStatus, setWorktreeStatus] = useState<WorktreeStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Fetch worktree status when dialog opens for an agent with a worktree
  useEffect(() => {
    if (!open || !deleteTarget) {
      setStep("confirm");
      setWorktreeStatus(null);
      setLoading(false);
      setDeleting(false);
      return;
    }

    if (!deleteTarget.worktreePath) {
      setWorktreeStatus(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    api<WorktreeStatus>(`/api/v1/agents/${deleteTarget.id}/worktree-status`)
      .then((status) => {
        if (!cancelled) {
          setWorktreeStatus(status);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWorktreeStatus(null);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, deleteTarget]);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;

    // If there's a worktree with unmerged commits or uncommitted changes, transition to choice step
    if (worktreeStatus?.hasWorktree && (worktreeStatus.hasUnmergedCommits || worktreeStatus.hasUncommittedChanges)) {
      setStep("worktree-choice");
      return;
    }

    // No worktree or no unmerged commits — standard delete with auto cleanup
    setDeleting(true);
    try {
      await onDelete(deleteTarget, "auto");
      setOpen(false);
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, worktreeStatus, onDelete, setOpen, setDeleteTarget]);

  const handleWorktreeChoice = useCallback(
    async (cleanupMode: "keep" | "force") => {
      if (!deleteTarget) return;

      setDeleting(true);
      try {
        await onDelete(deleteTarget, cleanupMode);
        setOpen(false);
        setDeleteTarget(null);
      } finally {
        setDeleting(false);
      }
    },
    [deleteTarget, onDelete, setOpen, setDeleteTarget]
  );

  const close = useCallback(() => {
    setOpen(false);
    setDeleteTarget(null);
  }, [setOpen, setDeleteTarget]);

  if (step === "worktree-choice" && worktreeStatus) {
    const hasUnmerged = worktreeStatus.hasUnmergedCommits && worktreeStatus.changedFiles.length > 0;
    const hasUncommitted = worktreeStatus.hasUncommittedChanges && worktreeStatus.uncommittedFiles.length > 0;

    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Worktree Has Outstanding Changes</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            {hasUnmerged && (
              <div className="flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-foreground">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  <span>
                    Branch <code className="rounded bg-muted px-1 py-0.5 text-xs">{worktreeStatus.branchName}</code> has
                    commits not merged to origin.
                  </span>
                </div>
                <div className="ml-6 max-h-40 overflow-y-auto rounded bg-muted/50 px-2 py-1.5 text-xs font-mono leading-relaxed text-muted-foreground">
                  {worktreeStatus.changedFiles.map((file) => (
                    <div key={file}>{file}</div>
                  ))}
                </div>
              </div>
            )}

            {hasUncommitted && (
              <div className="flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-foreground">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  <span>Worktree has uncommitted changes.</span>
                </div>
                <div className="ml-6 max-h-40 overflow-y-auto rounded bg-muted/50 px-2 py-1.5 text-xs font-mono leading-relaxed text-muted-foreground">
                  {worktreeStatus.uncommittedFiles.map((file) => (
                    <div key={file}>{file}</div>
                  ))}
                </div>
              </div>
            )}

            <p className="text-sm text-muted-foreground">The agent will be archived either way.</p>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={close} disabled={deleting}>
              Cancel
            </Button>
            <Button
              variant="default"
              disabled={deleting}
              onClick={() => void handleWorktreeChoice("keep")}
              data-testid="delete-agent-keep-worktree"
            >
              <GitBranch className="mr-1.5 h-4 w-4" />
              Archive, keep worktree
            </Button>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => void handleWorktreeChoice("force")}
              data-testid="delete-agent-force-worktree"
            >
              {deleting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Archive and remove worktree
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive Agent</DialogTitle>
          <DialogDescription>
            {deleteTarget
              ? `Archive "${deleteTarget.name}"? This removes the agent record and all media files.`
              : "Archive this agent?"}
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            data-testid="delete-agent-cancel"
            onClick={close}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            data-testid="delete-agent-confirm"
            disabled={loading || deleting}
            onClick={() => void handleConfirmDelete()}
          >
            {loading || deleting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Archive className="mr-1.5 h-4 w-4" />}
            Archive
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
