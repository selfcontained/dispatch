import { MessageSquareText } from "lucide-react";

import {
  formatJobDateTime,
  statusDotTone,
  statusTextColor,
  triggerSourceLabel,
} from "@/components/app/jobs-helpers";
import { RowButton } from "@/components/ui/row-button";
import { StatusDot } from "@/components/ui/status-dot";
import { type JobRun } from "@/hooks/use-jobs";
import { formatDuration } from "@/lib/format";
import { statusLabel } from "@/lib/status-label";
import { cn } from "@/lib/utils";
import {
  AsyncBoundary,
  type AsyncResult,
} from "@/components/ui/async-boundary";
import { EmptyState } from "@/components/ui/empty-state";

export function HistoryTab({
  query,
  selectedRunId,
  onSelectRun,
}: {
  query: AsyncResult<{ runs: JobRun[] }>;
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
}) {
  const runs = query.data?.runs ?? [];
  const selectedRun = selectedRunId
    ? (runs.find((run) => run.id === selectedRunId) ?? null)
    : null;
  return (
    <div className="mt-4 min-w-0">
      <AsyncBoundary
        query={query}
        thing="history"
        className="mb-2"
        isEmpty={() => runs.length === 0}
        empty={
          <EmptyState
            title="No runs yet."
            description="Runs show here once the job starts."
          />
        }
      >
        {() => (
          <div className="flex flex-col">
            {runs.map((run) => {
              const isSelected = selectedRun?.id === run.id;
              const isActive =
                run.status === "started" ||
                run.status === "running" ||
                run.status === "needs_input";
              return (
                <div key={run.id}>
                  <RowButton
                    className={cn(
                      "min-w-0 overflow-hidden py-1.5 text-body-sm hover:text-foreground",
                      isSelected ? "text-foreground" : "text-muted-foreground"
                    )}
                    onClick={() => onSelectRun(isSelected ? "" : run.id)}
                  >
                    <StatusDot
                      tone={statusDotTone(run.status)}
                      className={cn(isActive && "animate-pulse")}
                    />
                    <span
                      className={cn(
                        "shrink-0 font-medium",
                        statusTextColor(run.status)
                      )}
                    >
                      {statusLabel(run.status)}
                    </span>
                    <span className="min-w-0 truncate font-mono tabular-nums">
                      {formatJobDateTime(run.startedAt)}
                    </span>
                    <span className="font-mono tabular-nums opacity-50">
                      {formatDuration(run.durationMs)}
                    </span>
                    <span className="opacity-40">
                      {triggerSourceLabel(run)}
                    </span>
                  </RowButton>
                  {isSelected && <RunReport run={run} />}
                </div>
              );
            })}
          </div>
        )}
      </AsyncBoundary>
    </div>
  );
}

function RunReport({ run }: { run: JobRun | null }) {
  if (!run) {
    return (
      <div className="mb-2 ml-4 border-l-2 border-border pl-3 text-body-sm text-muted-foreground">
        Select a run.
      </div>
    );
  }
  return (
    <div className="mb-2 ml-0.5 border-l-2 border-border pl-4">
      {run.report?.summary && (
        <div className="pb-1 text-body-sm text-muted-foreground">
          {run.report.summary}
        </div>
      )}
      {run.report?.tasks.map((task, index) => (
        <div key={`${task.name}-${index}`} className="py-0.5">
          <div className="flex items-center gap-1.5 text-body-sm">
            <StatusDot
              size="sm"
              tone={
                task.status === "success"
                  ? "done"
                  : task.status === "error"
                    ? "blocked"
                    : "neutral"
              }
            />
            <span className="font-medium">{task.name}</span>
            {task.status === "error" && (
              <span className="uppercase text-danger">
                {statusLabel(task.status)}
              </span>
            )}
          </div>
          {task.summary ? (
            <div className="pl-4 text-body-sm text-faint">{task.summary}</div>
          ) : null}
          {task.errors?.map((error, errorIndex) => (
            <div key={errorIndex} className="pl-4 text-body-sm text-danger">
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
              className="pl-4 font-mono text-label-sm text-faint"
            >
              [{log.level}] {log.message}
            </div>
          ))}
        </div>
      ))}
      {run.pendingQuestion && (
        <div className="flex items-start gap-1.5 py-1 text-body-sm">
          <MessageSquareText className="mt-0.5 h-3 w-3 shrink-0 text-status-waiting" />
          <span className="text-status-waiting">{run.pendingQuestion}</span>
        </div>
      )}
      {run.completedAt && (
        <div className="pt-1 font-mono text-label-sm text-faint">
          Completed {formatJobDateTime(run.completedAt)}
        </div>
      )}
      {!run.report && !run.pendingQuestion && (
        <div className="text-body-sm text-muted-foreground">No report yet.</div>
      )}
    </div>
  );
}
