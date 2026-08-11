import { MessageSquareText } from "lucide-react";

import {
  formatJobDateTime,
  statusDotColor,
  statusTextColor,
  triggerSourceLabel,
} from "@/components/app/jobs-helpers";
import { ActivityBars } from "@/components/ui/activity-bars";
import { ScrollArea } from "@/components/ui/scroll-area";
import { type JobRun } from "@/hooks/use-jobs";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

export function HistoryTab({
  runs,
  loading,
  selectedRunId,
  onSelectRun,
}: {
  runs: JobRun[];
  loading: boolean;
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
}) {
  const selectedRun = selectedRunId
    ? (runs.find((run) => run.id === selectedRunId) ?? null)
    : null;
  return (
    <ScrollArea className="mt-4 min-h-0 h-full pr-1">
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ActivityBars size={16} /> Loading history...
        </div>
      ) : runs.length === 0 ? (
        <div className="text-sm text-muted-foreground">No runs yet.</div>
      ) : (
        <div className="flex flex-col">
          {runs.map((run) => {
            const isSelected = selectedRun?.id === run.id;
            const isActive =
              run.status === "started" ||
              run.status === "running" ||
              run.status === "needs_input";
            return (
              <div key={run.id}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2.5 overflow-hidden py-1.5 text-left text-xs transition-colors hover:text-foreground",
                    isSelected ? "text-foreground" : "text-muted-foreground"
                  )}
                  onClick={() => onSelectRun(isSelected ? "" : run.id)}
                >
                  <span
                    className={cn(
                      "h-2 w-2 shrink-0 rounded-full",
                      statusDotColor(run.status),
                      isActive && "animate-pulse"
                    )}
                  />
                  <span
                    className={cn(
                      "shrink-0 font-medium",
                      statusTextColor(run.status)
                    )}
                  >
                    {run.status}
                  </span>
                  <span className="min-w-0 truncate font-mono tabular-nums">
                    {formatJobDateTime(run.startedAt)}
                  </span>
                  <span className="font-mono tabular-nums opacity-50">
                    {formatDuration(run.durationMs)}
                  </span>
                  <span className="opacity-40">{triggerSourceLabel(run)}</span>
                </button>
                {isSelected && <RunReport run={run} />}
              </div>
            );
          })}
        </div>
      )}
    </ScrollArea>
  );
}

function RunReport({ run }: { run: JobRun | null }) {
  if (!run) {
    return (
      <div className="mb-2 ml-4 border-l-2 border-border pl-3 text-xs text-muted-foreground">
        Select a run.
      </div>
    );
  }
  return (
    <div className="mb-2 ml-[3px] border-l-2 border-border pl-4">
      {run.report?.summary && (
        <div className="pb-1 text-xs text-muted-foreground">
          {run.report.summary}
        </div>
      )}
      {run.report?.tasks.map((task, index) => (
        <div key={`${task.name}-${index}`} className="py-0.5">
          <div className="flex items-center gap-1.5 text-xs">
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                task.status === "success"
                  ? "bg-status-done"
                  : task.status === "error"
                    ? "bg-status-blocked"
                    : "bg-muted-foreground"
              )}
            />
            <span className="font-medium">{task.name}</span>
            {task.status === "error" && (
              <span className="uppercase text-status-blocked">
                {task.status}
              </span>
            )}
          </div>
          {task.summary ? (
            <div className="pl-3.5 text-xs text-muted-foreground/70">
              {task.summary}
            </div>
          ) : null}
          {task.errors?.map((error, errorIndex) => (
            <div
              key={errorIndex}
              className="pl-3.5 text-xs text-status-blocked"
            >
              {error.message}
              {error.action ? (
                <span className="ml-2 text-muted-foreground">
                  {error.action}
                </span>
              ) : null}
            </div>
          ))}
          {task.logs?.slice(-5).map((log, logIndex) => (
            <div
              key={logIndex}
              className="pl-3.5 font-mono text-[11px] text-muted-foreground/50"
            >
              [{log.level}] {log.message}
            </div>
          ))}
        </div>
      ))}
      {run.pendingQuestion && (
        <div className="flex items-start gap-1.5 py-1 text-xs">
          <MessageSquareText className="mt-0.5 h-3 w-3 shrink-0 text-status-waiting" />
          <span className="text-status-waiting">{run.pendingQuestion}</span>
        </div>
      )}
      {run.completedAt && (
        <div className="pt-1 font-mono text-[11px] text-muted-foreground/50">
          Completed {formatJobDateTime(run.completedAt)}
        </div>
      )}
      {!run.report && !run.pendingQuestion && (
        <div className="text-xs text-muted-foreground">No report yet.</div>
      )}
    </div>
  );
}
