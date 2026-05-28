import { useEffect, useRef } from "react";
import { CheckCircle2, ExternalLink, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OperationLog, PhaseProgress } from "@/components/app/release-shared";
import type { ReleaseJob } from "@/hooks/use-release-stream";
import { cleanError, formatProgressLabel } from "./release-manager-utils";

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
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [job.log]);

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      {/* Left column — controls */}
      <div className="flex md:w-[360px] shrink-0 flex-col gap-6 overflow-y-auto border-b md:border-b-0 md:border-r border-white/[0.12] p-4 md:p-6">
        {job.progress && (
          <div className="rounded-lg border border-white/[0.12] bg-white/[0.04] p-3">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
              Current step
            </div>
            <div className="mt-2 text-sm font-medium text-foreground">
              {job.progress.label}
            </div>
            {job.progress.detail && (
              <div className="mt-1 text-xs text-muted-foreground">
                {job.progress.detail}
              </div>
            )}
            {formatProgressLabel(job) && (
              <div className="mt-2 text-xs font-medium text-blue-300">
                {formatProgressLabel(job)}
              </div>
            )}
            {job.progress.totalBytes &&
              job.progress.bytesReceived !== null &&
              job.progress.bytesReceived !== undefined &&
              job.progress.totalBytes > 0 && (
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
                  <div
                    className="h-full rounded-full bg-blue-400 transition-[width] duration-200"
                    style={{
                      width: `${Math.min(
                        100,
                        (job.progress.bytesReceived / job.progress.totalBytes) *
                          100
                      )}%`,
                    }}
                  />
                </div>
              )}
          </div>
        )}

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
