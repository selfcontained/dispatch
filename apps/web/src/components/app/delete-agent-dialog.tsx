import type { AgentArchivePreview } from "@dispatch/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { type Agent } from "@/components/app/types";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { api } from "@/lib/api";

type DeleteStep = "confirm" | "worktree-choice";

type DeleteAgentDialogProps = {
  open: boolean;
  deleteTarget: Agent | null;
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
  setOpen,
  setDeleteTarget,
  onDelete,
}: DeleteAgentDialogProps): JSX.Element {
  const [step, setStep] = useState<DeleteStep>("confirm");
  const targetId = deleteTarget?.id;
  const preview = useQuery({
    queryKey: ["agent-archive-preview", targetId],
    queryFn: () =>
      api<AgentArchivePreview>(`/api/v1/agents/${targetId}/archive-preview`),
    enabled: open && Boolean(targetId),
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  useEffect(() => {
    setStep("confirm");
  }, [open, targetId]);

  const worktreeStatus = preview.data?.worktreeStatus;
  const unreadable = preview.data?.worktreeStatusUnreadable;
  const cascadeCount = preview.data?.subAgentCount ?? 0;
  const cleanupDescriptions = preview.data?.cleanupDescriptions ?? [];
  const cascadeNote =
    cascadeCount > 0
      ? ` Its ${cascadeCount} sub agent${cascadeCount === 1 ? "" : "s"} ${
          cascadeCount === 1 ? "is" : "are"
        } archived too.`
      : "";
  const previewReady = preview.isSuccess && !preview.isFetching;
  const choosing = step === "worktree-choice" && Boolean(worktreeStatus);
  const name = deleteTarget ? `“${deleteTarget.name}”` : "this agent";
  const archive = async (cleanup: "auto" | "keep" | "force") => {
    if (deleteTarget) await onDelete(deleteTarget, cleanup);
  };

  const confirm = async () => {
    if (unreadable) return archive("keep");
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
        <>
          {unreadable
            ? cascadeNote
            : choosing
              ? `The agent will be archived either way.${cascadeNote}`
              : `This removes the agent record and all files.${cascadeNote}`}
          {cleanupDescriptions.length > 0 ? (
            <span className="mt-2 block text-foreground">
              {cleanupDescriptions.join(" ")}
              {unreadable || worktreeStatus?.hasWorktree
                ? " Keeping the worktree still runs this cleanup."
                : null}
            </span>
          ) : null}
        </>
      }
      confirmLabel={
        unreadable
          ? "Archive, keep worktree"
          : choosing
            ? "Archive and remove worktree"
            : "Archive agent"
      }
      confirmTestId={
        choosing ? "delete-agent-force-worktree" : "delete-agent-confirm"
      }
      cancelTestId="delete-agent-cancel"
      errorTitle="Couldn’t archive the agent."
      checking={preview.isFetching}
      confirmDisabled={!previewReady}
      onConfirm={confirm}
      alternative={
        choosing && previewReady
          ? {
              label: "Archive, keep worktree",
              testId: "delete-agent-keep-worktree",
              onConfirm: () => archive("keep"),
            }
          : undefined
      }
    >
      {unreadable ? (
        <Alert
          tone="warning"
          title="Worktree cleanup failed; leaving on disk."
        />
      ) : null}
      {preview.isError ? (
        <Alert title="Couldn’t check what archive will remove.">
          <Button
            variant="secondary"
            size="sm"
            pending={preview.isFetching}
            onClick={() => void preview.refetch()}
          >
            Retry
          </Button>
        </Alert>
      ) : null}
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
