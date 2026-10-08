import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { OperationLog, PhaseProgress } from "@/components/app/release-shared";
import type { ReleaseJob } from "@/hooks/use-release-stream";
import { cleanError, formatProgressLabel } from "./release-utils";

type OperationTakeoverProps = {
  job: ReleaseJob;
  phasesOrder: string[];
  isDone: boolean;
  isFailed: boolean;
  isRestarting: boolean;
  postRestartPolling: boolean;
  status: { tag: string | null; deployedAt: string | null } | null;
  onDismiss: () => void;
};

export function OperationTakeover({
  job,
  phasesOrder,
  isDone,
  isFailed,
  isRestarting,
  postRestartPolling,
  status,
  onDismiss,
}: OperationTakeoverProps): JSX.Element {
  const [waitingSeconds, setWaitingSeconds] = useState(0);
  const waiting = !isDone && !isFailed && (isRestarting || postRestartPolling);
  useEffect(() => {
    if (!waiting) {
      setWaitingSeconds(0);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => {
      setWaitingSeconds(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [waiting]);
  const progress =
    isDone && job.jobType === "update"
      ? {
          step: "update-complete",
          label: "Update complete",
          detail: "Dispatch is ready. Reloading the app…",
        }
      : waiting && !job.progress?.step.startsWith("restart-")
        ? {
            step: "restarting-service",
            label: "Restarting and verifying Dispatch",
            detail:
              "The protected update verifies the backup and checks the new version for at least a minute before committing. This page will reload automatically when ready.",
          }
        : job.progress;
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [job.log]);

  return (
    <div
      data-testid="release-operation-panel"
      className={cn(
        "flex min-h-0 flex-col md:flex-row",
        job.jobType === "update" ? "h-[720px] shrink-0 md:h-[560px]" : "h-full"
      )}
    >
      {/* Left column — controls */}
      <div
        className={cn(
          "flex md:w-[360px] shrink-0 flex-col overflow-y-auto border-b md:border-b-0 md:border-r border-white/[0.12] p-4 md:p-6",
          job.jobType === "update"
            ? "h-[496px] gap-4 md:h-full md:gap-6"
            : "gap-6"
        )}
      >
        <div
          data-testid="release-current-step"
          className={cn(
            job.jobType === "update"
              ? "h-[216px] shrink-0 overflow-y-auto"
              : "contents"
          )}
        >
          {progress && (
            <div
              className={cn(
                job.jobType === "update" && "h-full",
                "rounded-lg border border-white/[0.12] bg-white/[0.04] p-3"
              )}
            >
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Current step
              </div>
              <div className="mt-2 text-sm font-medium text-foreground">
                {progress.label}
              </div>
              {progress.detail && (
                <div className="mt-1 text-xs text-muted-foreground">
                  {progress.detail}
                </div>
              )}
              {formatProgressLabel({ ...job, progress }) && (
                <div className="mt-2 text-xs font-medium text-blue-300">
                  {formatProgressLabel({ ...job, progress })}
                </div>
              )}
              {progress.totalBytes &&
                progress.bytesReceived !== null &&
                progress.bytesReceived !== undefined &&
                progress.totalBytes > 0 && (
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
                    <div
                      className="h-full rounded-full bg-blue-400 transition-[width] duration-200"
                      style={{
                        width: `${Math.min(
                          100,
                          (progress.bytesReceived / progress.totalBytes) * 100
                        )}%`,
                      }}
                    />
                  </div>
                )}
            </div>
          )}
        </div>

        <PhaseProgress
          job={job}
          phasesOrder={phasesOrder}
          isFailed={isFailed}
          isRestarting={isRestarting}
        />

        {job.runUrl && (
          <a
            href={job.runUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 self-start text-xs text-blue-400 hover:underline"
          >
            <ExternalLink className="h-3 w-3" />
            View GitHub Actions run
          </a>
        )}

        <div
          data-testid="release-operation-status"
          className={cn(
            job.jobType === "update"
              ? "h-28 shrink-0 overflow-y-auto"
              : "contents"
          )}
        >
          {waiting && (
            <div className="text-xs text-muted-foreground" role="status">
              Checking for the updated server… {waitingSeconds}s elapsed
              {waitingSeconds >= 120 && (
                <div className="mt-2">
                  This is taking longer than usual. Still checking
                  automatically; the recovery helper may be restoring the
                  previous version.
                </div>
              )}
            </div>
          )}

          {isDone && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2 rounded border border-green-500/30 bg-green-500/10 px-3 py-2.5 text-sm text-green-400">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>
                  {job.jobType === "update" ? "Updated to" : "Released"}{" "}
                  <span className="font-mono font-semibold">
                    {job.tag ?? status?.tag}
                  </span>
                </span>
              </div>
              {job.jobType === "update" && (
                <div className="text-xs text-muted-foreground">
                  Reloading the app…
                </div>
              )}
              <Button
                variant="default"
                onClick={onDismiss}
                className="self-start text-muted-foreground hover:text-foreground"
              >
                Done
              </Button>
            </div>
          )}

          {isFailed && (
            <div className="flex flex-col gap-3">
              <div className="flex items-start gap-2 rounded border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {job.error ? cleanError(job.error) : "Operation failed"}
                </span>
              </div>
              <Button
                variant="default"
                onClick={onDismiss}
                className="self-start text-muted-foreground hover:text-foreground"
              >
                Dismiss
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Right column — log */}
      <OperationLog
        logRef={logRef}
        job={job}
        isRestarting={isRestarting}
        postRestartPolling={postRestartPolling}
      />
    </div>
  );
}
