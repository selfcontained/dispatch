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
import {
  ChartFrame,
  DashboardSection,
  Legend,
  Meter,
} from "@/components/ui/dashboard";

// A colour is one series across the page. Failed and waiting are run states,
// so they keep their status colours.
const RUN_SERIES = {
  completed: { label: "Completed", color: "hsl(var(--chart-1))" },
  failed: { label: "Failed", color: "hsl(var(--status-blocked))" },
  running: { label: "Running", color: "hsl(var(--chart-3))" },
  waiting: { label: "Needs input", color: "hsl(var(--status-waiting))" },
} satisfies ChartConfig;
const DURATION_COLOR = "hsl(var(--chart-4))";

function runSeries(status: JobRunStatus): keyof typeof RUN_SERIES | null {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "timed_out" || status === "crashed")
    return "failed";
  if (status === "running" || status === "started") return "running";
  if (status === "needs_input") return "waiting";
  return null;
}

const dailyRunsChartConfig = {
  completed: RUN_SERIES.completed,
  failed: RUN_SERIES.failed,
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
    <ChartContainer
      config={dailyRunsChartConfig}
      className="aspect-auto min-h-0 w-full flex-1"
    >
      <BarChart data={data} barCategoryGap="20%">
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
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
        <ChartLegend content={<ChartLegendContent />} />
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
    <DashboardSection title="Avg duration" range="recent runs">
      <ChartFrame>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {perJob.jobs.map((job) => (
            <Meter
              key={job.name}
              label={job.name}
              value={formatDuration(job.avg)}
              ratio={job.avg / perJob.maxAvg}
              color={DURATION_COLOR}
            />
          ))}
        </div>
      </ChartFrame>
    </DashboardSection>
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
  const shown = new Set(
    perJob.flatMap((job) => job.runs.map((run) => runSeries(run.status)))
  );
  const legend = Object.entries(RUN_SERIES)
    .filter(([key]) => shown.has(key as keyof typeof RUN_SERIES))
    .map(([key, series]) => ({ key, ...series }));

  return (
    <DashboardSection title="Run history" range="recent runs">
      <ChartFrame>
        <TooltipProvider delayDuration={80}>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
            {perJob.map(({ name, runs: jobRuns }) => (
              <div key={name}>
                <div className="mb-1 truncate text-body-sm text-foreground">
                  {name}
                </div>
                <div
                  className="grid gap-px"
                  style={{
                    gridTemplateColumns: `repeat(${MAX_RUN_CELLS}, minmax(0, 1fr))`,
                  }}
                >
                  {Array.from({ length: MAX_RUN_CELLS }, (_, i) => {
                    const run = i < jobRuns.length ? jobRuns[i] : null;
                    if (!run)
                      return (
                        <div
                          key={i}
                          className="h-4 rounded-mark bg-surface-subtle sm:h-3"
                        />
                      );
                    const series = runSeries(run.status);
                    return (
                      <Tooltip key={i}>
                        <TooltipTrigger asChild>
                          <div
                            className="h-4 rounded-mark bg-surface-hover sm:h-3"
                            style={{
                              backgroundColor: series
                                ? RUN_SERIES[series].color
                                : undefined,
                            }}
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
        <Legend items={legend} className="pt-3" />
      </ChartFrame>
    </DashboardSection>
  );
}
