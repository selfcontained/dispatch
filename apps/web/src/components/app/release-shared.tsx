import { Loader2 } from "lucide-react";
import type { ReleaseJob, ReleasePhase } from "@/hooks/use-release-stream";
import { cn } from "@/lib/utils";

const PHASE_LABELS: Record<ReleasePhase, string> = {
  preflight: "Pre-flight",
  triggering: "Trigger workflow",
  watching: "CI running",
  fetching: "Fetching",
  deploying: "Deploying",
  restarting: "Restarting",
  done: "Complete",
  failed: "Failed"
};

type PhaseProgressProps = {
  job: ReleaseJob;
  phasesOrder: string[];
  isFailed: boolean;
  isRestarting: boolean;
};

export function PhaseProgress({ job, phasesOrder, isFailed, isRestarting }: PhaseProgressProps): JSX.Element {
  const phaseIndex = phasesOrder.indexOf(job.phase);

  return (
    <div>
      <div className="mb-3 text-[10px] uppercase tracking-widest text-muted-foreground">Progress</div>
      <div className="flex flex-col gap-2">
        {phasesOrder.filter((p) => p !== "done").map((phase, i) => {
          const current = phaseIndex === i;
          const done = phaseIndex > i || job.phase === "done";
          return (
            <div key={phase} className="flex items-center gap-3">
              <div className={cn(
                "h-2 w-2 rounded-full shrink-0",
                done && "bg-status-working",
                current && !isFailed && "animate-pulse bg-status-waiting",
                current && isFailed && "bg-destructive",
                !done && !current && "bg-muted"
              )} />
              <span className={cn(
                "text-sm",
                done && "text-muted-foreground",
                current && !isFailed && "text-foreground font-medium",
                current && isFailed && "text-destructive font-medium",
                !done && !current && "text-muted-foreground/50"
              )}>
                {PHASE_LABELS[phase as ReleasePhase] ?? phase}
              </span>
              {current && isRestarting && phase === "restarting" && (
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

type OperationLogProps = {
  logRef: React.Ref<HTMLDivElement>;
  job: ReleaseJob;
  isRestarting: boolean;
  postRestartPolling: boolean;
};

export function OperationLog({ logRef, job, isRestarting, postRestartPolling }: OperationLogProps): JSX.Element {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col p-2">
      <div
        ref={logRef}
        className="min-h-0 flex-1 overflow-y-auto bg-black/60 p-4 font-mono text-[12px] leading-relaxed text-green-300"
      >
        {job.log
          .filter((line) => line.trim() !== "DISPATCH_RESTARTING")
          .map((line, i) => (
            <div key={i}>{line || "\u00A0"}</div>
          ))}
        {(isRestarting || postRestartPolling) && !job.log.length && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Waiting for Dispatch to restart...
          </div>
        )}
      </div>
    </div>
  );
}
