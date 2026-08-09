import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  fillGaps,
  formatBucketLabel,
  msToMinutes,
} from "@/components/app/activity-chart-utils";
import { formatDuration } from "@/lib/format";
import type {
  ActivityGranularity,
  DailyStatusEntry,
} from "@/hooks/use-activity";

// ── Status colors & config ──────────────────────────────────────────

const STATUS_ORDER = ["working", "blocked", "waiting_user"];

const chartConfig: ChartConfig = {
  working: { label: "Working", color: "hsl(var(--status-working))" },
  blocked: { label: "Blocked", color: "hsl(var(--status-blocked))" },
  waiting_user: { label: "Waiting", color: "hsl(var(--status-waiting))" },
};

// ── Daily stacked bar chart (recharts) ──────────────────────────────

export function DailyStackedBarChart({
  data: rawData,
  granularity,
  dailyDate,
}: {
  data: DailyStatusEntry[];
  granularity: ActivityGranularity;
  dailyDate?: string;
}) {
  const chartData = useMemo(() => {
    const filled = fillGaps<DailyStatusEntry>(
      rawData,
      granularity,
      (day) => ({ day }),
      dailyDate
    );
    return filled.map((d) => ({
      day: d.day,
      label: formatBucketLabel(d.day, granularity),
      working: msToMinutes(d.working ?? 0),
      blocked: msToMinutes(d.blocked ?? 0),
      waiting_user: msToMinutes(d.waiting_user ?? 0),
    }));
  }, [granularity, rawData, dailyDate]);

  if (chartData.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        Not enough data yet
      </div>
    );
  }

  return (
    <ChartContainer
      config={chartConfig}
      className="aspect-[1.5/1] sm:aspect-[2.5/1] w-full"
    >
      <BarChart data={chartData} barCategoryGap="20%">
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          interval="preserveStartEnd"
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              indicator="dot"
              formatter={(value, name, item) => (
                <>
                  <div
                    className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                    style={{ backgroundColor: item.color }}
                  />
                  <div className="flex flex-1 items-center justify-between gap-8">
                    <span className="text-muted-foreground">
                      {chartConfig[name as string]?.label ?? name}
                    </span>
                    <span className="font-mono font-medium text-foreground tabular-nums">
                      {formatDuration((value as number) * 60_000)}
                    </span>
                  </div>
                </>
              )}
              labelFormatter={(label) => label as string}
            />
          }
        />
        <ChartLegend
          content={<ChartLegendContent className="flex-wrap gap-2 sm:gap-4" />}
        />
        {STATUS_ORDER.map((key) => (
          <Bar
            key={key}
            dataKey={key}
            stackId="status"
            fill={`var(--color-${key})`}
            radius={key === "waiting_user" ? [2, 2, 0, 0] : 0}
          />
        ))}
      </BarChart>
    </ChartContainer>
  );
}
