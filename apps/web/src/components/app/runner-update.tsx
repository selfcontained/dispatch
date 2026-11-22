import type { RunnerUpdatePhaseView, RunnerUpdateView } from "@dispatch/shared";
import { Loader2 } from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button, LoadingButton } from "@/components/ui/button";
import { useStartRunnerUpdate, type Runner } from "@/hooks/use-runners";
import { ApiError } from "@/lib/api";
import { RunnerCommand, useRunnerInstaller } from "./runner-onboarding";

const PHASES: Record<
  Exclude<RunnerUpdatePhaseView, "draining" | "interrupting" | "resuming">,
  string
> = {
  staging: "Downloading and verifying…",
  settling: "Waiting for work to settle…",
  switching: "Switching to the new build…",
  confirming: "Confirming the new build…",
  cancelling: "Cancelling the update…",
};

const ROLLED_BACK: Record<string, string> = {
  boot_failed: "The new build didn’t start.",
  confirm_timeout: "The new build wasn’t confirmed in time.",
  reattach_failed: "Running agents didn’t reconnect to the new build.",
  trial_interrupted: "The runner was interrupted while testing the new build.",
  verify_failed: "The new build didn’t match the one Dispatch sent.",
  identity_mismatch: "The new build didn’t match the one Dispatch sent.",
  cancelled: "The runner cancelled the update.",
};

const DEFERRED: Record<string, string> = {
  drain_timeout: "The wait for agents timed out.",
  force_timeout: "Dispatch couldn’t stop every agent in time.",
  operations_pending: "The runner was still busy, so it didn’t switch.",
  verify_failed: "The runner couldn’t download or verify the build.",
  boot_failed: "The runner couldn’t restart to switch builds.",
  trial_interrupted: "The runner was interrupted before it could switch.",
  suppressed: "This build failed on this runner before.",
  cancelled: "The runner cancelled the update before switching.",
  staging_timeout: "Downloading and verifying took too long.",
  settle_timeout: "Work on the runner didn’t settle in time.",
  attach_unavailable:
    "Dispatch couldn’t reach every agent running on the runner.",
  runner_newer: "The runner already has this version or newer.",
};

/** Reasons Dispatch gives, whatever state the runner ended in. */
const STOPPED: Record<string, string> = {
  dispatch_changed: "Dispatch changed builds during the update.",
  interrupted: "Dispatch lost track of the update, so it cancelled it.",
  no_response: "The runner didn’t report back in time.",
  switch_timeout: "The runner didn’t finish switching in time.",
  state_unsaved: "Dispatch couldn’t save the update’s progress.",
  unsupported: "The runner reconnected without update support.",
  revoked: "The runner’s access was revoked.",
};

function describeResult({
  state,
  version,
  reason = "",
  floorVersion,
}: NonNullable<RunnerUpdateView["result"]>): {
  title: string;
  detail?: string;
} {
  const update = version ? `Update to ${version}` : "The update";
  switch (state) {
    case "updated":
      return { title: version ? `Updated to ${version}` : "Runner updated" };
    case "needs_idle":
      return {
        title: `${update} needs all agents idle`,
        detail:
          "This build can’t take over running agents. When they’re idle, run this on the runner.",
      };
    case "rolled_back":
      return {
        title: `${update} rolled back`,
        detail:
          ROLLED_BACK[reason] ??
          STOPPED[reason] ??
          "The runner restored its previous build.",
      };
    case "deferred":
      if (reason === "drain_cancelled")
        return { title: `${update} was cancelled` };
      if (reason === "downgrade")
        return {
          title: `${update} was refused`,
          detail: floorVersion
            ? `The runner refused it as a downgrade. Its version floor is ${floorVersion}.`
            : "The runner refused it as a downgrade.",
        };
      return {
        title:
          reason === "suppressed"
            ? `${update} is blocked`
            : `${update} didn’t finish`,
        detail:
          DEFERRED[reason] ??
          STOPPED[reason] ??
          "The runner stopped the update.",
      };
  }
}

function UpdateCommand() {
  const { data } = useRunnerInstaller(true);
  return data?.command ? (
    <div className="text-xs">
      <RunnerCommand value={data.command} label="Update" />
    </div>
  ) : null;
}

/** Update now cuts work off, so it asks first. */
function UpdateNow({
  runnerName,
  loading,
  disabled,
  onConfirm,
}: {
  runnerName: string;
  loading: boolean;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        {/* Not a LoadingButton: focus returns here through the ref. */}
        <Button
          type="button"
          size="sm"
          variant="primary"
          disabled={disabled}
          aria-busy={loading || undefined}
        >
          {loading && (
            <Loader2
              className="mr-1.5 size-3.5 shrink-0 animate-spin"
              aria-hidden="true"
            />
          )}
          Update now
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle className="break-words text-base font-semibold">
          Update {runnerName} now?
        </AlertDialogTitle>
        <AlertDialogDescription className="text-sm text-muted-foreground">
          Running turns are interrupted and resumed after the update. Open
          terminals close, and any tool call in progress is lost.
        </AlertDialogDescription>
        <div className="flex flex-wrap justify-end gap-2">
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            Update now
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function RunnerUpdateStatus({ runner }: { runner: Runner }) {
  const start = useStartRunnerUpdate(runner.id);
  const { attempt, available, result, previousBuildAgents } =
    runner.update ?? {};
  const pending =
    start.isPending && typeof start.variables === "object"
      ? start.variables.action
      : undefined;
  // A refusal is stale once an update is running or has landed.
  const error =
    (attempt && attempt.phase !== "draining") ||
    (!available && result?.state === "updated")
      ? null
      : start.error;
  if (!attempt && !available && !result && !previousBuildAgents && !error)
    return null;

  const failed = result !== undefined && result.state !== "updated";
  let title: string | undefined;
  let detail: string | undefined;
  if (attempt) {
    title = attempt.version
      ? `Updating to ${attempt.version}`
      : "Runner update in progress";
    const count = attempt.agents ?? 0;
    const agents = `${count} ${count === 1 ? "agent" : "agents"}`;
    detail =
      runner.status === "offline"
        ? "Waiting for the runner to reconnect…"
        : attempt.phase === "draining"
          ? `Waiting on ${agents}`
          : attempt.phase === "interrupting"
            ? // Not counted until Dispatch has looked at the runner's hosts.
              attempt.agents
              ? `Interrupting ${agents}`
              : "Interrupting agents…"
            : attempt.phase === "resuming"
              ? `Resuming ${agents}`
              : PHASES[attempt.phase];
  } else if (result && (failed || !available)) {
    ({ title, detail } = describeResult(result));
  } else if (available) {
    title = `Update available: ${available.version}`;
  }
  const needsCommand =
    (!attempt && result?.state === "needs_idle") ||
    (error instanceof ApiError &&
      ["no_artifact", "same_version", "unsupported"].includes(
        error.code ?? ""
      ));

  return (
    <div className="space-y-2 pb-1" data-testid="runner-update">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div
          role="status"
          className="min-w-0 flex-1 basis-64 space-y-0.5 text-xs text-muted-foreground"
        >
          {title && (
            <p className="break-words text-sm font-medium text-foreground">
              {title}
            </p>
          )}
          {detail && (
            <p className="flex items-center gap-1.5">
              {attempt && (
                <Loader2
                  className="size-3 shrink-0 animate-spin"
                  aria-hidden="true"
                />
              )}
              {detail}
            </p>
          )}
          {attempt?.held &&
            attempt.phase !== "draining" &&
            attempt.phase !== "interrupting" &&
            attempt.phase !== "resuming" && (
              <p>New work waits until the update finishes.</p>
            )}
          {!attempt && previousBuildAgents ? (
            <p>
              {previousBuildAgents}{" "}
              {previousBuildAgents === 1 ? "agent" : "agents"} still on the
              previous build
            </p>
          ) : null}
          {!attempt && available && (
            <>
              {failed && available.version !== result.version && (
                <p>Update available: {available.version}</p>
              )}
              {available.action === "retry" &&
                result?.reason !== "suppressed" && (
                  <p>This build is blocked on this runner until you retry.</p>
                )}
              <p>Updating closes open terminals on this runner.</p>
            </>
          )}
        </div>
        {attempt?.phase === "draining" && (
          <div className="flex flex-wrap gap-2">
            <LoadingButton
              type="button"
              size="sm"
              variant="default"
              loading={pending === "cancel"}
              disabled={start.isPending}
              onClick={() =>
                start.mutate({ action: "cancel", attemptId: attempt.id })
              }
            >
              Cancel
            </LoadingButton>
            <UpdateNow
              key={attempt.id}
              runnerName={runner.name}
              loading={pending === "force"}
              disabled={start.isPending}
              onConfirm={() =>
                start.mutate({ action: "force", attemptId: attempt.id })
              }
            />
          </div>
        )}
        {!attempt && available && (
          <LoadingButton
            type="button"
            size="sm"
            variant="primary"
            loading={start.isPending}
            onClick={() => start.mutate(available.action)}
            data-testid={`runner-update-${runner.id}`}
          >
            {available.action === "retry" ? "Retry" : "Update"}
          </LoadingButton>
        )}
      </div>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error.message}
        </p>
      )}
      {needsCommand && <UpdateCommand />}
    </div>
  );
}
