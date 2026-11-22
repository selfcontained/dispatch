import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Archive, GitBranch } from "lucide-react";

import { type Agent } from "@/components/app/types";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { descendantAgents } from "@/lib/agent-lineage";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";

type WorktreeStatus = {
  hasWorktree: boolean;
  ownership?: "owned" | "borrowed" | "external" | "none";
  borrowers?: string[];
  checkoutState?: string;
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
  /** Every agent currently known, so the dialog can name what archives with the target. */
  agents: Agent[];
  setOpen: (open: boolean) => void;
  setDeleteTarget: (agent: Agent | null) => void;
  onDelete: (
    agent: Agent,
    cleanupWorktree?: string,
    checkoutState?: string
  ) => Promise<void>;
};

export function DeleteAgentDialog({
  open,
  deleteTarget,
  agents,
  setOpen,
  setDeleteTarget,
  onDelete,
}: DeleteAgentDialogProps): JSX.Element {
  const [step, setStep] = useState<DeleteStep>("confirm");
  const [worktreeStatus, setWorktreeStatus] = useState<WorktreeStatus | null>(
    null
  );
  const [loading, setLoading] = useState(false);
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Archiving cascades to the target's sub agents, so the confirmation has to
  // say how many go with it — otherwise a parent's archive silently takes out
  // work the user never had in view.
  const cascadeCount = useMemo(
    () => (deleteTarget ? descendantAgents(deleteTarget.id, agents).length : 0),
    [deleteTarget, agents]
  );
  const cascadeNote =
    cascadeCount > 0
      ? ` Its ${cascadeCount} sub agent${cascadeCount === 1 ? "" : "s"} ${
          cascadeCount === 1 ? "is" : "are"
        } archived too.`
      : "";

  const runnerCheckout = Boolean(
    deleteTarget?.runnerManaged || deleteTarget?.cwd.startsWith("runner://")
  );

  // Remote checkout ownership is known only to the session runner.
  useEffect(() => {
    setStatusUnavailable(false);
    setWorktreeStatus(null);
    if (!open || !deleteTarget) {
      setStep("confirm");
      setLoading(false);
      setDeleting(false);
      setError(null);
      return;
    }

    if (!deleteTarget.worktreePath && !runnerCheckout) {
      setLoading(false);
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
          setStatusUnavailable(true);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, deleteTarget, runnerCheckout]);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;

    // If there's a worktree with unmerged commits or uncommitted changes, transition to choice step
    if (
      worktreeStatus?.hasWorktree &&
      worktreeStatus.ownership !== "borrowed" &&
      worktreeStatus.ownership !== "external" &&
      (worktreeStatus.hasUnmergedCommits ||
        worktreeStatus.hasUncommittedChanges)
    ) {
      setStep("worktree-choice");
      return;
    }

    // The server checks again before allowing automatic cleanup.
    setDeleting(true);
    setError(null);
    try {
      if (worktreeStatus?.checkoutState)
        await onDelete(deleteTarget, "auto", worktreeStatus.checkoutState);
      else await onDelete(deleteTarget, "auto");
      setOpen(false);
      setDeleteTarget(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, worktreeStatus, onDelete, setOpen, setDeleteTarget]);

  const handleWorktreeChoice = useCallback(
    async (cleanupMode: "keep" | "force") => {
      if (!deleteTarget) return;

      setDeleting(true);
      setError(null);
      try {
        if (cleanupMode === "force" && worktreeStatus?.checkoutState)
          await onDelete(
            deleteTarget,
            cleanupMode,
            worktreeStatus.checkoutState
          );
        else await onDelete(deleteTarget, cleanupMode);
        setOpen(false);
        setDeleteTarget(null);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setDeleting(false);
      }
    },
    [deleteTarget, onDelete, setOpen, setDeleteTarget, worktreeStatus]
  );

  const close = useCallback(() => {
    setOpen(false);
    setDeleteTarget(null);
  }, [setOpen, setDeleteTarget]);

  // Dismissing mid-request would leave a failure nowhere to show.
  const onOpenChange = (next: boolean) => {
    if (!deleting) setOpen(next);
  };
  const failure = error ? (
    <p role="alert" className="break-words text-body-md text-danger">
      Couldn't archive the agent: {error}
    </p>
  ) : null;

  if (step === "worktree-choice" && worktreeStatus) {
    const hasUnmerged = worktreeStatus.hasUnmergedCommits;
    const hasUncommitted =
      worktreeStatus.hasUncommittedChanges &&
      worktreeStatus.uncommittedFiles.length > 0;

    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Worktree Has Outstanding Changes</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            {hasUnmerged && (
              <div className="flex flex-col gap-2 rounded-md border border-warning/line bg-warning/tint px-3 py-3 text-body-md text-foreground">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  <span>
                    {worktreeStatus.branchName && (
                      <>
                        Branch{" "}
                        <code className="rounded-sm bg-muted px-1 py-0.5 text-body-sm">
                          {worktreeStatus.branchName}
                        </code>{" "}
                      </>
                    )}
                    {worktreeStatus.branchName ? "has" : "This checkout has"}{" "}
                    unmerged commits.
                  </span>
                </div>
                <div className="ml-6 max-h-40 overflow-y-auto rounded-sm bg-surface-hover px-2 py-1.5 text-body-sm font-mono leading-relaxed text-muted-foreground">
                  {worktreeStatus.changedFiles.map((file) => (
                    <div key={file}>{file}</div>
                  ))}
                </div>
              </div>
            )}

            {hasUncommitted && (
              <div className="flex flex-col gap-2 rounded-md border border-warning/line bg-warning/tint px-3 py-3 text-body-md text-foreground">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  <span>Worktree has uncommitted changes.</span>
                </div>
                <div className="ml-6 max-h-40 overflow-y-auto rounded-sm bg-surface-hover px-2 py-1.5 text-body-sm font-mono leading-relaxed text-muted-foreground">
                  {worktreeStatus.uncommittedFiles.map((file) => (
                    <div key={file}>{file}</div>
                  ))}
                </div>
              </div>
            )}

            <p className="text-body-md text-muted-foreground">
              The agent will be archived either way.
              {worktreeStatus.borrowers?.length
                ? " Removal waits until the other sessions release the worktree."
                : ""}
              {cascadeNote}
            </p>
          </div>

          {failure}
          <div className="grid gap-2 pt-1 sm:grid-cols-[auto,minmax(0,1fr),minmax(0,1fr)]">
            <Button
              variant="ghost"
              onClick={close}
              disabled={deleting}
              className="w-full sm:w-auto"
            >
              Cancel
            </Button>
            <Button
              disabled={deleting}
              onClick={() => void handleWorktreeChoice("keep")}
              data-testid="delete-agent-keep-worktree"
              wrap
              className="w-full"
            >
              <GitBranch />
              Archive, keep worktree
            </Button>
            <Button
              variant="danger"
              disabled={deleting}
              onClick={() => void handleWorktreeChoice("force")}
              data-testid="delete-agent-force-worktree"
              wrap
              className="w-full"
            >
              {deleting ? <ActivityBars size={16} /> : null}
              Archive and remove worktree
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive Agent</DialogTitle>
          <DialogDescription>
            {deleteTarget
              ? `Archive "${deleteTarget.name}"?${cascadeNote}`
              : "Archive this agent?"}
            {statusUnavailable
              ? runnerCheckout
                ? " Checkout status is unavailable. The runner will check it when available and keep it if it cannot verify that it is clean."
                : " Checkout status is unavailable. Archive will keep it unless it can verify that it is clean."
              : worktreeStatus?.ownership === "borrowed"
                ? " The shared checkout belongs to another session."
                : worktreeStatus?.borrowers?.length
                  ? " Checkout removal waits until the other sessions release it."
                  : worktreeStatus?.ownership === "owned"
                    ? " Archive removes the checkout if it is still clean and unchanged."
                    : ""}
          </DialogDescription>
        </DialogHeader>
        {failure}
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            data-testid="delete-agent-cancel"
            onClick={close}
            disabled={deleting}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            data-testid="delete-agent-confirm"
            disabled={loading || deleting}
            onClick={() => void handleConfirmDelete()}
          >
            {loading || deleting ? <ActivityBars size={16} /> : <Archive />}
            Archive
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
