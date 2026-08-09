import { useMemo } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  fillGaps,
  formatBucketLabel,
} from "@/components/app/activity-chart-utils";
import { formatTokenCount } from "@/lib/format";
import type {
  ActivityGranularity,
  AgentsCreatedEntry,
  TokenDailyEntry,
} from "@/hooks/use-activity";

// ── Token daily chart ─────────────────────────────────────────────

const TOKEN_ORDER = [
  "input_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "output_tokens",
];

const tokenChartConfig: ChartConfig = {
  input_tokens: { label: "Input", color: "hsl(var(--chart-1))" },
  cache_read_tokens: { label: "Cache read", color: "hsl(var(--chart-3))" },
  cache_creation_tokens: { label: "Cache write", color: "hsl(var(--chart-4))" },
  output_tokens: { label: "Output", color: "hsl(var(--chart-2))" },
  agents_created: { label: "Agents created", color: "hsl(var(--foreground))" },
};

const EMPTY_TOKEN_ENTRY = (day: string): TokenDailyEntry => ({
  day,
  input_tokens: 0,
  cache_creation_tokens: 0,
  cache_read_tokens: 0,
  output_tokens: 0,
  messages: 0,
});

export function DailyTokenChart({
  data: rawData,
  granularity,
  agentsCreatedData,
  dailyDate,
}: {
  data: TokenDailyEntry[];
  granularity: ActivityGranularity;
  agentsCreatedData?: AgentsCreatedEntry[];
  dailyDate?: string;
}) {
  const chartData = useMemo(() => {
    const filled = fillGaps(rawData, granularity, EMPTY_TOKEN_ENTRY, dailyDate);
    const agentsMap = new Map(
      agentsCreatedData?.map((d) => [d.day, d.count]) ?? []
    );
    return filled.map((d) => ({
      ...d,
      label: formatBucketLabel(d.day, granularity),
      agents_created: agentsMap.get(d.day) ?? 0,
    }));
  }, [granularity, rawData, agentsCreatedData, dailyDate]);

  const hasAgentsLine = chartData.some((d) => d.agents_created > 0);

  if (chartData.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        No token data yet
      </div>
    );
  }

  return (
    <ChartContainer
      config={tokenChartConfig}
      className="aspect-[1.5/1] sm:aspect-[2.5/1] w-full"
    >
      <ComposedChart data={chartData} barCategoryGap="20%">
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          interval="preserveStartEnd"
        />
        <YAxis yAxisId="tokens" hide />
        {hasAgentsLine && <YAxis yAxisId="agents" orientation="right" hide />}
        <ChartTooltip
          content={({ active, payload, label: tooltipLabel }) => {
            if (!active || !payload?.length) return null;
            const tokenEntries = payload.filter(
              (p) => p.dataKey !== "agents_created"
            );
            const total = tokenEntries.reduce(
              (sum, p) => sum + (typeof p.value === "number" ? p.value : 0),
              0
            );
            return (
              <div className="rounded-lg border border-white/[0.2] bg-[hsl(var(--card))] backdrop-blur-2xl px-3 py-2 text-xs shadow-[0_16px_64px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.15)]">
                <div className="mb-1.5 font-medium">{tooltipLabel}</div>
                {payload.map((p) => (
                  <div
                    key={String(p.dataKey)}
                    className="flex items-center gap-2 py-0.5"
                  >
                    <div
                      className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                      style={{
                        backgroundColor:
                          tokenChartConfig[p.dataKey as string]?.color,
                      }}
                    />
                    <span className="flex-1 text-muted-foreground">
                      {tokenChartConfig[p.dataKey as string]?.label ??
                        String(p.dataKey)}
                    </span>
                    <span className="font-mono font-medium text-foreground tabular-nums">
                      {p.dataKey === "agents_created"
                        ? String(p.value)
                        : formatTokenCount(p.value as number)}
                    </span>
                  </div>
                ))}
                {tokenEntries.length > 1 && (
                  <div className="mt-1.5 flex items-center gap-2 border-t border-border pt-1.5">
                    <div className="h-2.5 w-2.5 shrink-0" />
                    <span className="flex-1 font-medium text-foreground">
                      Total
                    </span>
                    <span className="font-mono font-medium text-foreground tabular-nums">
                      {formatTokenCount(total)}
                    </span>
                  </div>
                )}
              </div>
            );
          }}
        />
        <ChartLegend
          content={<ChartLegendContent className="flex-wrap gap-2 sm:gap-4" />}
        />
        {TOKEN_ORDER.map((key) => (
          <Bar
            key={key}
            dataKey={key}
            yAxisId="tokens"
            stackId="tokens"
            fill={tokenChartConfig[key]?.color}
            radius={key === "output_tokens" ? [2, 2, 0, 0] : 0}
          />
        ))}
        {hasAgentsLine && (
          <Line
            type="monotone"
            dataKey="agents_created"
            yAxisId="agents"
            stroke="var(--color-agents_created)"
            strokeWidth={2}
            dot={{ r: 3, fill: "var(--color-agents_created)" }}
          />
        )}
      </ComposedChart>
    </ChartContainer>
  );
}
