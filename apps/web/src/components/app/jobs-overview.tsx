import { Activity, AlarmClock, Clock } from "lucide-react";
import { useMemo } from "react";

import {
  DailyRunsChart,
  JobAvgDuration,
  RunHistoryGrid,
} from "@/components/app/jobs-charts";
import { statusDotTone, statusTextColor } from "@/components/app/jobs-helpers";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RowButton } from "@/components/ui/row-button";
import { StatusDot } from "@/components/ui/status-dot";
import { Hint } from "@/components/ui/tooltip";
import { StatCard } from "@/components/app/stat-card";
import { type Job, type JobStats } from "@/hooks/use-jobs";
import {
  formatDateTime,
  formatDayTime,
  formatDuration,
  formatRelativeTime,
  formatTimeUntil,
} from "@/lib/format";
import { statusLabel } from "@/lib/status-label";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingSkeleton, Skeleton } from "@/components/ui/skeleton";

export function JobsOverview({
  jobs,
  stats,
  statsLoading,
  onSelectJob,
  onSelectRun,
}: {
  jobs: Job[];
  stats: JobStats | null;
  statsLoading: boolean;
  onSelectJob: (job: Job) => void;
  onSelectRun: (jobId: string, runId: string) => void;
}) {
  const upcomingJobs = useMemo(() => {
    return jobs
      .filter((j) => j.nextRun)
      .sort(
        (a, b) =>
          new Date(a.nextRun!).getTime() - new Date(b.nextRun!).getTime()
      )
      .slice(0, 5);
  }, [jobs]);

  const recentRuns = stats?.recentRuns ?? [];
  const metrics = stats?.stats ?? null;
  const hasAnyData = jobs.length > 0;

  const successRate =
    metrics && metrics.totalRuns > 0
      ? Math.round((metrics.successCount / metrics.totalRuns) * 100)
      : null;

  const dailyChartData = useMemo(() => {
    if (!metrics?.daily?.length) return [];
    const byDay = new Map(metrics.daily.map((d) => [d.day, d]));
    const days: Array<{
      day: string;
      label: string;
      completed: number;
      failed: number;
    }> = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const entry = byDay.get(key);
      days.push({
        day: key,
        label: d.toLocaleDateString(undefined, { weekday: "short" }),
        completed: entry?.completed ?? 0,
        failed: entry?.failed ?? 0,
      });
    }
    return days;
  }, [metrics?.daily]);

  if (!hasAnyData) {
    return (
      <div className="flex h-full flex-col">
        <EmptyState
          icon={AlarmClock}
          title="No jobs yet"
          description="Use jobs for recurring maintenance, scheduled checks, and repeatable agent workflows — on a schedule or on demand."
        />
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-5xl space-y-6 px-3 pt-4 pb-12 sm:px-4 sm:pt-6 sm:pb-20 md:px-8">
        {/* Loading */}
        {statsLoading && !metrics && (
          <LoadingSkeleton label="Loading run history…" className="space-y-6">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
              {Array.from({ length: 4 }, (_, card) => (
                <Skeleton key={card} className="h-20" />
              ))}
            </div>
            <Skeleton className="h-[180px] sm:h-[220px]" />
          </LoadingSkeleton>
        )}

        {/* Stats + Chart row */}
        {metrics && metrics.totalRuns > 0 && (
          <>
            <div className="flex flex-wrap gap-2 sm:gap-3">
              <StatCard
                label="Total Runs"
                value={metrics.totalRuns}
                sub="Last 7 days"
              />
              <StatCard
                label="Success Rate"
                value={successRate !== null ? `${successRate}%` : "-"}
                sub="Last 7 days"
                variant={
                  successRate !== null && successRate < 80
                    ? "warning"
                    : undefined
                }
              />
              <StatCard
                label="Avg Duration"
                value={
                  metrics.avgDurationMs
                    ? formatDuration(metrics.avgDurationMs)
                    : "-"
                }
                sub="Last 7 days"
              />
              <StatCard
                label="Failures"
                value={metrics.failureCount}
                sub="Last 7 days"
                variant={metrics.failureCount > 0 ? "warning" : undefined}
              />
            </div>
            {/* Charts 3-up row */}
            <div className="flex flex-col gap-4 sm:flex-row [&>*]:sm:flex-1 [&>*]:sm:min-w-0">
              {dailyChartData.length > 0 && (
                <div>
                  <h3 className="mb-2 section-label">Daily Runs</h3>
                  <div className="h-[180px] sm:h-[220px] rounded-md border border-border bg-surface-subtle p-3">
                    <DailyRunsChart data={dailyChartData} />
                  </div>
                </div>
              )}
              <JobAvgDuration runs={recentRuns} />
              <RunHistoryGrid runs={recentRuns} />
            </div>
          </>
        )}

        {/* Upcoming */}
        {upcomingJobs.length > 0 && (
          <div>
            <div className="mb-2 flex items-center gap-2 section-label">
              <Clock className="h-3.5 w-3.5" />
              Upcoming
            </div>
            <div className="divide-y divide-border rounded-md border border-border bg-surface-subtle">
              {upcomingJobs.map((job) => (
                <RowButton
                  key={job.id}
                  className="justify-between rounded-none px-3 py-3 text-body-md"
                  onClick={() => onSelectJob(job)}
                >
                  <span className="font-medium text-foreground">
                    {job.name}
                  </span>
                  <span className="flex items-center gap-2 text-body-sm text-muted-foreground">
                    <Hint label={formatDateTime(job.nextRun!)}>
                      <span>{formatTimeUntil(job.nextRun!)}</span>
                    </Hint>
                    <span className="hidden text-faint sm:inline">
                      {formatDayTime(job.nextRun!)}
                    </span>
                  </span>
                </RowButton>
              ))}
            </div>
          </div>
        )}

        {/* Recent Activity */}
        {recentRuns.length > 0 && (
          <div>
            <div className="mb-2 flex items-center gap-2 section-label">
              <Activity className="h-3.5 w-3.5" />
              Recent Activity
            </div>
            <div className="divide-y divide-border rounded-md border border-border bg-surface-subtle">
              {recentRuns
                .filter((run) => jobs.some((j) => j.id === run.jobId))
                .slice(0, 8)
                .map((run) => {
                  return (
                    <RowButton
                      key={run.id}
                      className="gap-3 rounded-none px-3 py-3 text-body-md"
                      onClick={() => onSelectRun(run.jobId, run.id)}
                    >
                      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                        {run.jobName}
                      </span>
                      <span
                        className={cn(
                          "flex shrink-0 items-center gap-1.5 text-body-sm",
                          statusTextColor(run.status)
                        )}
                      >
                        <StatusDot tone={statusDotTone(run.status)} size="sm" />
                        {statusLabel(run.status)}
                      </span>
                      <span className="shrink-0 text-body-sm tabular-nums text-muted-foreground">
                        {formatDuration(run.durationMs)}
                      </span>
                      <Hint label={formatDateTime(run.startedAt)}>
                        <span className="shrink-0 text-body-sm text-faint">
                          {formatRelativeTime(run.startedAt)}
                        </span>
                      </Hint>
                    </RowButton>
                  );
                })}
            </div>
          </div>
        )}

        {/* Empty metrics state — jobs exist but no runs yet */}
        {metrics && metrics.totalRuns === 0 && (
          <EmptyState
            icon={AlarmClock}
            title="Select a job"
            description={
              upcomingJobs.length > 0
                ? "Your scheduled jobs are set up. Run history and metrics will appear here after the first run."
                : "Run a job to start tracking activity and metrics here."
            }
          />
        )}
      </div>
    </ScrollArea>
  );
}
