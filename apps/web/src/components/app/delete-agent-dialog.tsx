import { useEffect, useMemo, useState } from "react";

import { type Agent } from "@/components/app/types";
import { Alert } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
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

function FileList({ files }: { files: string[] }): JSX.Element {
  return (
    <ul className="mt-1 max-h-40 overflow-y-auto rounded-sm bg-surface-hover px-2 py-1.5 font-mono text-body-sm leading-relaxed text-muted-foreground">
      {files.map((file) => (
        <li key={file} className="break-all">
          {file}
        </li>
      ))}
    </ul>
  );
}

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

  // Fetch worktree status when dialog opens for an agent with a worktree
  useEffect(() => {
    setStep("confirm");
    setWorktreeStatus(null);
    setLoading(false);
    if (!open || !deleteTarget?.worktreePath) return;

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

  const choosing = step === "worktree-choice" && worktreeStatus !== null;
  const name = deleteTarget ? `“${deleteTarget.name}”` : "this agent";
  const archive = async (cleanup: "auto" | "keep" | "force") => {
    if (deleteTarget) await onDelete(deleteTarget, cleanup);
  };

  const confirm = async () => {
    if (choosing) return archive("force");
    // Outstanding work gets a choice of what happens to the worktree.
    if (
      worktreeStatus?.hasWorktree &&
      (worktreeStatus.hasUnmergedCommits ||
        worktreeStatus.hasUncommittedChanges)
    ) {
      setStep("worktree-choice");
      return false;
    }
    return archive("auto");
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setDeleteTarget(null);
      }}
      title={
        choosing
          ? `Archive ${name} with outstanding changes?`
          : `Archive ${name}?`
      }
      description={
        choosing
          ? `The agent will be archived either way.${cascadeNote}`
          : `This removes the agent record and all files.${cascadeNote}`
      }
      confirmLabel={choosing ? "Archive and remove worktree" : "Archive agent"}
      confirmTestId={
        choosing ? "delete-agent-force-worktree" : "delete-agent-confirm"
      }
      cancelTestId="delete-agent-cancel"
      errorTitle="Couldn’t archive the agent."
      checking={loading}
      onConfirm={confirm}
      alternative={
        choosing
          ? {
              label: "Archive, keep worktree",
              testId: "delete-agent-keep-worktree",
              onConfirm: () => archive("keep"),
            }
          : undefined
      }
    >
      {choosing && worktreeStatus ? (
        <>
          {worktreeStatus.hasUnmergedCommits &&
          worktreeStatus.changedFiles.length > 0 ? (
            <Alert
              tone="warning"
              title={
                <>
                  Branch{" "}
                  <code className="rounded-sm bg-muted px-1 py-0.5 text-body-sm">
                    {worktreeStatus.branchName}
                  </code>{" "}
                  has commits not merged to origin.
                </>
              }
            >
              <FileList files={worktreeStatus.changedFiles} />
            </Alert>
          ) : null}
          {worktreeStatus.hasUncommittedChanges &&
          worktreeStatus.uncommittedFiles.length > 0 ? (
            <Alert tone="warning" title="Worktree has uncommitted changes.">
              <FileList files={worktreeStatus.uncommittedFiles} />
            </Alert>
          ) : null}
        </>
      ) : null}
    </ConfirmDialog>
  );
}
