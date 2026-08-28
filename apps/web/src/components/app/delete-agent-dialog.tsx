import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Archive, GitBranch, RefreshCw } from "lucide-react";

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

type WorktreeStatus = {
  hasWorktree: boolean;
  hasUnmergedCommits: boolean;
  hasUncommittedChanges: boolean;
  worktreePath: string | null;
  branchName: string | null;
  changedFiles: string[];
  uncommittedFiles: string[];
};

/** One agent's worktree in the cascade the archive is about to sweep. */
type AgentWorktreeStatus = WorktreeStatus & {
  agentId: string;
  agentName: string;
  isTarget: boolean;
};

const hasOutstandingWork = (status: AgentWorktreeStatus) =>
  status.hasWorktree &&
  (status.hasUnmergedCommits || status.hasUncommittedChanges);

type DeleteStep = "confirm" | "worktree-choice";

type DeleteAgentDialogProps = {
  open: boolean;
  deleteTarget: Agent | null;
  /** Every agent currently known, so the dialog can name what archives with the target. */
  agents: Agent[];
  setOpen: (open: boolean) => void;
  setDeleteTarget: (agent: Agent | null) => void;
  onDelete: (agent: Agent, cleanupWorktree?: string) => Promise<void>;
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
  const [worktreeStatuses, setWorktreeStatuses] = useState<
    AgentWorktreeStatus[]
  >([]);
  // Distinguishes "no worktrees hold work" from "we could not find out". Only
  // the first is safe to archive on without asking.
  const [statusError, setStatusError] = useState(false);
  const [statusComplete, setStatusComplete] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);

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

  // Worktree status for the whole cascade, not just the target: archiving the
  // parent discards its children's worktrees too, so the confirmation has to be
  // able to show what is in them before offering that. The server walks the
  // subtree — asking per agent from here would be a round trip each, and each
  // one shells out to git.
  useEffect(() => {
    if (!open || !deleteTarget) {
      setStep("confirm");
      setWorktreeStatuses([]);
      setStatusError(false);
      setStatusComplete(true);
      setLoading(false);
      setDeleting(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setStatusError(false);
    api<{ statuses: AgentWorktreeStatus[]; complete?: boolean }>(
      `/api/v1/agents/${deleteTarget.id}/worktree-status/subtree`
    )
      .then((payload) => {
        if (!cancelled) {
          setWorktreeStatuses(payload.statuses ?? []);
          setStatusComplete(payload.complete !== false);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWorktreeStatuses([]);
          setStatusComplete(true);
          setStatusError(true);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, deleteTarget, reloadToken]);

  const outstanding = useMemo(
    () => worktreeStatuses.filter(hasOutstandingWork),
    [worktreeStatuses]
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;

    // Anything in the cascade holding work sends the user to the choice step —
    // a child's unfinished work is as much a reason to stop and ask as the
    // target's own. So does an incomplete preview: "we did not finish looking"
    // must not archive on the same silent path as "there is nothing to lose".
    if (outstanding.length > 0 || !statusComplete) {
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
  }, [
    deleteTarget,
    outstanding,
    statusComplete,
    onDelete,
    setOpen,
    setDeleteTarget,
  ]);

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

  if (
    step === "worktree-choice" &&
    (outstanding.length > 0 || !statusComplete)
  ) {
    const multiple = outstanding.length > 1;

    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {!statusComplete
                ? "Worktrees Could Not Be Fully Checked"
                : multiple
                  ? `${outstanding.length} Worktrees Have Outstanding Changes`
                  : "Worktree Has Outstanding Changes"}
            </DialogTitle>
          </DialogHeader>

          <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto">
            {!statusComplete && (
              <div
                className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-foreground"
                data-testid="worktree-preview-incomplete"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <span>
                  This archive covers more worktrees than could be checked in
                  time, so some may hold unsaved work that is not listed here.
                </span>
              </div>
            )}

            {outstanding.map((status) => {
              const hasUnmerged =
                status.hasUnmergedCommits && status.changedFiles.length > 0;
              const hasUncommitted =
                status.hasUncommittedChanges &&
                status.uncommittedFiles.length > 0;

              return (
                <div
                  key={status.agentId}
                  className="flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-foreground"
                  data-testid={`worktree-outstanding-${status.agentId}`}
                >
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                    <span>
                      <span className="font-medium">{status.agentName}</span>
                      {status.isTarget ? null : (
                        <span className="text-muted-foreground">
                          {" "}
                          (sub agent)
                        </span>
                      )}
                      {status.branchName ? (
                        <>
                          {" — "}
                          <code className="rounded bg-muted px-1 py-0.5 text-xs">
                            {status.branchName}
                          </code>
                        </>
                      ) : null}
                    </span>
                  </div>

                  {hasUnmerged && (
                    <div className="ml-6 flex flex-col gap-1">
                      <span className="text-xs text-muted-foreground">
                        Commits not merged to origin:
                      </span>
                      <div className="max-h-32 overflow-y-auto rounded bg-muted/50 px-2 py-1.5 text-xs font-mono leading-relaxed text-muted-foreground">
                        {status.changedFiles.map((file) => (
                          <div key={file}>{file}</div>
                        ))}
                      </div>
                    </div>
                  )}

                  {hasUncommitted && (
                    <div className="ml-6 flex flex-col gap-1">
                      <span className="text-xs text-muted-foreground">
                        Uncommitted changes:
                      </span>
                      <div className="max-h-32 overflow-y-auto rounded bg-muted/50 px-2 py-1.5 text-xs font-mono leading-relaxed text-muted-foreground">
                        {status.uncommittedFiles.map((file) => (
                          <div key={file}>{file}</div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <p className="text-sm text-muted-foreground">
            {!statusComplete
              ? "Removing worktrees is unavailable until the check completes."
              : multiple
                ? "Removing worktrees discards the work listed above in all of them."
                : "The agent will be archived either way."}
            {cascadeNote}
          </p>

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
              variant="default"
              disabled={deleting}
              onClick={() => void handleWorktreeChoice("keep")}
              data-testid="delete-agent-keep-worktree"
              className="h-auto w-full min-w-0 whitespace-normal py-2 text-center"
            >
              <GitBranch className="mr-1.5 h-4 w-4" />
              {multiple ? "Archive, keep worktrees" : "Archive, keep worktree"}
            </Button>
            <Button
              variant="destructive"
              disabled={deleting || !statusComplete}
              onClick={() => void handleWorktreeChoice("force")}
              data-testid="delete-agent-force-worktree"
              className="h-auto w-full min-w-0 whitespace-normal py-2 text-center"
            >
              {deleting ? <ActivityBars size={16} className="mr-1.5" /> : null}
              {multiple
                ? "Archive and remove worktrees"
                : "Archive and remove worktree"}
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
              ? `Archive "${deleteTarget.name}"? This removes the agent record and all media files.${cascadeNote}`
              : "Archive this agent?"}
          </DialogDescription>
        </DialogHeader>

        {statusError && (
          <div
            className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-foreground"
            data-testid="worktree-check-failed"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <span>
              Couldn&apos;t check whether this agent or its sub agents have
              unsaved work. Retry before archiving.
            </span>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            data-testid="delete-agent-cancel"
            onClick={close}
          >
            Cancel
          </Button>
          {statusError ? (
            // Archiving here would skip the worktree confirmation entirely, at
            // the one moment we cannot say what it would discard.
            <Button
              variant="default"
              data-testid="delete-agent-retry-status"
              disabled={loading}
              onClick={() => setReloadToken((token) => token + 1)}
            >
              {loading ? (
                <ActivityBars size={16} className="mr-1.5" />
              ) : (
                <RefreshCw className="mr-1.5 h-4 w-4" />
              )}
              Retry
            </Button>
          ) : (
            <Button
              variant="destructive"
              data-testid="delete-agent-confirm"
              disabled={loading || deleting}
              onClick={() => void handleConfirmDelete()}
            >
              {loading || deleting ? (
                <ActivityBars size={16} className="mr-1.5" />
              ) : (
                <Archive className="mr-1.5 h-4 w-4" />
              )}
              Archive
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
