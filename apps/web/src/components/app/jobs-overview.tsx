import { Activity, AlarmClock, Clock } from "lucide-react";
import { useMemo } from "react";

import {
  DailyRunsChart,
  JobAvgDuration,
  RunHistoryGrid,
} from "@/components/app/jobs-charts";
import {
  formatTimeUntil,
  formatTimeUntilDate,
  statusTextColor,
} from "@/components/app/jobs-helpers";
import { ActivityBars } from "@/components/ui/activity-bars";
import { ScrollArea } from "@/components/ui/scroll-area";
import { StatCard } from "@/components/app/stat-card";
import { type Job, type JobStats } from "@/hooks/use-jobs";
import { formatDuration, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

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
      <div className="flex h-full items-center justify-center p-8 text-center text-muted-foreground">
        <div>
          <AlarmClock className="mx-auto mb-3 h-8 w-8" />
          <div className="font-medium text-foreground">No jobs yet</div>
          <div className="mt-1 max-w-sm text-sm">
            Use jobs for recurring maintenance, scheduled checks, and repeatable
            agent workflows — on a schedule or on demand.
          </div>
        </div>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-5xl space-y-6 px-3 pt-4 pb-12 sm:px-5 sm:pt-6 sm:pb-20 md:px-8">
        {/* Loading */}
        {statsLoading && !metrics && (
          <div className="flex items-center justify-center py-12">
            <ActivityBars size={20} />
          </div>
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
                  <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Daily Runs
                  </h3>
                  <div className="h-[180px] sm:h-[220px] rounded-md border border-border bg-muted/40 p-3">
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
            <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              Upcoming
            </div>
            <div className="divide-y divide-border rounded-md border border-border bg-muted/40">
              {upcomingJobs.map((job) => (
                <button
                  key={job.id}
                  className="flex w-full items-center justify-between px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/50"
                  onClick={() => onSelectJob(job)}
                >
                  <span className="font-medium text-foreground">
                    {job.name}
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{formatTimeUntil(job.nextRun!)}</span>
                    <span className="hidden text-muted-foreground/60 sm:inline">
                      {formatTimeUntilDate(job.nextRun!)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Recent Activity */}
        {recentRuns.length > 0 && (
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <Activity className="h-3.5 w-3.5" />
              Recent Activity
            </div>
            <div className="divide-y divide-border rounded-md border border-border bg-muted/40">
              {recentRuns
                .filter((run) => jobs.some((j) => j.id === run.jobId))
                .slice(0, 8)
                .map((run) => {
                  return (
                    <button
                      key={run.id}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/50"
                      onClick={() => onSelectRun(run.jobId, run.id)}
                    >
                      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                        {run.jobName}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 text-xs capitalize",
                          statusTextColor(run.status)
                        )}
                      >
                        {run.status}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {formatDuration(run.durationMs)}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground/60">
                        {formatRelativeTime(run.startedAt)}
                      </span>
                    </button>
                  );
                })}
            </div>
          </div>
        )}

        {/* Empty metrics state — jobs exist but no runs yet */}
        {metrics && metrics.totalRuns === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
            <AlarmClock className="mb-3 h-8 w-8" />
            <div className="font-medium text-foreground">Select a job</div>
            <div className="mt-1 max-w-sm text-sm">
              {upcomingJobs.length > 0
                ? "Your scheduled jobs are set up. Run history and metrics will appear here after the first run."
                : "Run a job to start tracking activity and metrics here."}
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
