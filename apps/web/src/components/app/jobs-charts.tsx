import { useMemo } from "react";
import { Bar, BarChart, XAxis } from "recharts";

import { formatDuration, formatRelativeTime } from "@/lib/format";
import { statusLabel } from "@/lib/status-label";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { type JobRunStatus } from "@/hooks/use-jobs";
import { cn } from "@/lib/utils";

const dailyRunsChartConfig = {
  completed: { label: "Completed", color: "hsl(var(--chart-1))" },
  failed: { label: "Failed", color: "hsl(var(--status-blocked))" },
} satisfies ChartConfig;

export function DailyRunsChart({
  data,
}: {
  data: Array<{
    day: string;
    label: string;
    completed: number;
    failed: number;
  }>;
}) {
  return (
    <ChartContainer config={dailyRunsChartConfig} className="h-full w-full">
      <BarChart data={data} barCategoryGap="20%">
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          tick={{ fontSize: 11 }}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              indicator="dot"
              formatter={(value, name, item) => (
                <>
                  <div
                    className="h-2.5 w-2.5 shrink-0 rounded-mark"
                    style={{ backgroundColor: item.color }}
                  />
                  <div className="flex flex-1 items-center justify-between gap-4">
                    <span className="text-muted-foreground">
                      {dailyRunsChartConfig[
                        name as keyof typeof dailyRunsChartConfig
                      ]?.label ?? name}
                    </span>
                    <span className="font-mono font-medium tabular-nums text-foreground">
                      {value as number}
                    </span>
                  </div>
                </>
              )}
              labelFormatter={(label) => label as string}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent className="gap-2" />} />
        <Bar
          dataKey="completed"
          stackId="runs"
          fill="var(--color-completed)"
          radius={0}
        />
        <Bar
          dataKey="failed"
          stackId="runs"
          fill="var(--color-failed)"
          radius={[2, 2, 0, 0]}
        />
      </BarChart>
    </ChartContainer>
  );
}

export function JobAvgDuration({
  runs,
}: {
  runs: Array<{ jobName: string; durationMs: number | null }>;
}) {
  const perJob = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const run of runs) {
      if (run.durationMs == null) continue;
      if (!map.has(run.jobName)) map.set(run.jobName, []);
      map.get(run.jobName)!.push(run.durationMs);
    }
    const result = [...map.entries()].map(([name, durations]) => ({
      name,
      avg: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
      runs: durations.length,
    }));
    const maxAvg = Math.max(...result.map((j) => j.avg), 1);
    return { jobs: result, maxAvg };
  }, [runs]);

  if (perJob.jobs.length === 0) return null;

  return (
    <div>
      <h3 className="mb-2 section-label">Avg Duration</h3>
      <div className="h-[180px] sm:h-[220px] rounded-md border border-border bg-surface-subtle p-3 flex flex-col justify-center">
        <div className="flex flex-col gap-3 overflow-y-auto min-h-0">
          {perJob.jobs.map((job) => (
            <div key={job.name}>
              <div className="mb-1 flex items-center justify-between">
                <span className="truncate text-body-sm text-muted-foreground">
                  {job.name}
                </span>
                <span className="text-body-sm font-medium tabular-nums text-foreground">
                  {formatDuration(job.avg)}
                </span>
              </div>
              <div className="flex h-2 overflow-hidden rounded-sm bg-surface-hover">
                <div
                  className="bg-chart-1/soft transition-all rounded-sm"
                  style={{ width: `${(job.avg / perJob.maxAvg) * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const MAX_RUN_CELLS = 16;

export function RunHistoryGrid({
  runs,
}: {
  runs: Array<{
    jobId: string;
    jobName: string;
    status: JobRunStatus;
    startedAt: string;
  }>;
}) {
  const perJob = useMemo(() => {
    const grouped = new Map<
      string,
      Array<{ status: JobRunStatus; startedAt: string }>
    >();
    for (const run of runs) {
      if (!grouped.has(run.jobName)) grouped.set(run.jobName, []);
      grouped
        .get(run.jobName)!
        .push({ status: run.status, startedAt: run.startedAt });
    }
    const result: Array<{
      name: string;
      runs: Array<{ status: JobRunStatus; startedAt: string }>;
    }> = [];
    for (const [name, jobRuns] of grouped) {
      result.push({ name, runs: jobRuns.slice(0, MAX_RUN_CELLS).reverse() });
    }
    return result;
  }, [runs]);

  if (perJob.length === 0) return null;

  return (
    <div>
      <h3 className="mb-2 section-label">Run History</h3>
      <div className="h-[180px] sm:h-[220px] rounded-md border border-border bg-surface-subtle p-3 flex flex-col justify-between">
        <TooltipProvider delayDuration={80}>
          <div className="space-y-2 overflow-y-auto min-h-0 flex-1">
            {perJob.map(({ name, runs: jobRuns }) => (
              <div key={name}>
                <div className="mb-1 truncate text-label-xs text-muted-foreground">
                  {name}
                </div>
                <div
                  className="grid gap-px"
                  style={{
                    gridTemplateColumns: `repeat(${MAX_RUN_CELLS}, 1fr)`,
                  }}
                >
                  {Array.from({ length: MAX_RUN_CELLS }, (_, i) => {
                    const run = i < jobRuns.length ? jobRuns[i] : null;
                    if (!run)
                      return (
                        <div key={i} className="h-4 sm:h-3 bg-surface-subtle" />
                      );
                    return (
                      <Tooltip key={i}>
                        <TooltipTrigger asChild>
                          <div
                            className={cn(
                              "h-4 sm:h-3",
                              run.status === "completed" &&
                                "bg-status-done/soft",
                              (run.status === "failed" ||
                                run.status === "timed_out" ||
                                run.status === "crashed") &&
                                "bg-status-blocked/soft",
                              (run.status === "running" ||
                                run.status === "started") &&
                                "bg-status-working/soft",
                              run.status === "needs_input" &&
                                "bg-status-waiting/soft"
                            )}
                          />
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-body-sm">
                          {statusLabel(run.status)} —{" "}
                          {formatRelativeTime(run.startedAt)}
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </TooltipProvider>
        <div className="flex items-center gap-2 text-label-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-3 bg-status-done/soft" />
            Completed
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-3 bg-status-blocked/soft" />
            Failed
          </span>
        </div>
      </div>
    </div>
  );
}
