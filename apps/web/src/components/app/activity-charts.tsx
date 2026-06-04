import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { cn } from "@/lib/utils";
import {
  formatDuration,
  formatShortDate,
  formatTokenCount,
  shortProjectName,
} from "@/lib/format";
import type {
  ActivityGranularity,
  AgentsCreatedEntry,
  DailyStatusEntry,
  TokenDailyEntry,
  TokenByModel,
  TokenByProject,
  WorkingTimeByProject,
} from "@/hooks/use-activity";

// ── Helpers ─────────────────────────────────────────────────────────

export function formatDate(iso: string): string {
  return formatShortDate(iso);
}

function formatBucketLabel(
  iso: string,
  granularity: ActivityGranularity
): string {
  if (granularity === "hour") {
    // iso is like "2026-04-14 09:00"
    const hourStr = iso.split(" ")[1] ?? "00:00";
    const hour = parseInt(hourStr.split(":")[0], 10);
    const suffix = hour >= 12 ? "pm" : "am";
    const normalized = hour % 12 === 0 ? 12 : hour % 12;
    return `${normalized}${suffix}`;
  }
  const d = new Date(iso + "T00:00:00");
  if (granularity === "month") {
    return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  }
  if (granularity === "week") {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return formatDate(iso);
}

function msToMinutes(ms: number): number {
  return Math.round(ms / 60_000);
}

// ── Status colors & config ──────────────────────────────────────────

const STATUS_ORDER = ["working", "blocked", "waiting_user"];

const chartConfig: ChartConfig = {
  working: { label: "Working", color: "hsl(var(--status-working))" },
  blocked: { label: "Blocked", color: "hsl(var(--status-blocked))" },
  waiting_user: { label: "Waiting", color: "hsl(var(--status-waiting))" },
};

// ── Gap filling ─────────────────────────────────────────────────────

function fillGaps<T extends { day: string }>(
  data: T[],
  granularity: ActivityGranularity,
  defaultEntry: (day: string) => T,
  dailyDate?: string
): T[] {
  if (granularity === "hour") {
    // Fill all 24 hours for the selected day
    const dataMap = new Map(data.map((d) => [d.day, d]));
    const datePrefix =
      dailyDate ??
      (data.length > 0
        ? data[0].day.split(" ")[0]
        : new Date().toISOString().slice(0, 10));
    const filled: T[] = [];
    for (let h = 0; h < 24; h++) {
      const key = `${datePrefix} ${String(h).padStart(2, "0")}:00`;
      filled.push(dataMap.get(key) ?? defaultEntry(key));
    }
    return filled;
  }
  if (granularity !== "day") return data;
  if (data.length < 2) return data;
  const filled: T[] = [];
  const dataMap = new Map(data.map((d) => [d.day, d]));
  const start = new Date(data[0].day + "T00:00:00");
  const end = new Date(data[data.length - 1].day + "T00:00:00");
  const cursor = new Date(start);
  while (cursor <= end) {
    const iso = cursor.toISOString().slice(0, 10);
    filled.push(dataMap.get(iso) ?? defaultEntry(iso));
    cursor.setDate(cursor.getDate() + 1);
  }
  return filled;
}

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

// ── Token helpers ──────────────────────────────────────────────────

function shortModelName(model: string): string {
  if (model.includes("opus")) return "Opus";
  if (model.includes("sonnet")) return "Sonnet";
  if (model.includes("haiku")) return "Haiku";
  if (model.includes("gpt-5")) return "GPT-5";
  if (model.includes("gpt-4")) return "GPT-4";
  return model;
}

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

// ── Horizontal bar helper ──────────────────────────────────────────

function HorizontalBar({
  label,
  value,
  maxValue,
  color = "bg-emerald-500/70",
  sub,
}: {
  label: string;
  value: number;
  maxValue: number;
  color?: string;
  sub?: string;
}) {
  const pct = maxValue > 0 ? (value / maxValue) * 100 : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="truncate text-foreground">{label}</span>
        <span className="ml-2 shrink-0 font-mono text-muted-foreground tabular-nums">
          {formatTokenCount(value)}
          {sub ? ` ${sub}` : ""}
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-muted/60">
        <div
          className={cn("h-2 rounded-full transition-all", color)}
          style={{ width: `${Math.max(pct, 1)}%` }}
        />
      </div>
    </div>
  );
}

// ── Per-model breakdown ───────────────────────────────────────────

export function ModelBreakdown({ data }: { data: TokenByModel[] }) {
  if (data.length === 0) return null;
  const max = Math.max(
    ...data.map(
      (m) =>
        m.total_input +
        m.total_cache_creation +
        m.total_cache_read +
        m.total_output
    )
  );

  return (
    <div className="space-y-3">
      {data.map((m) => {
        const total =
          m.total_input +
          m.total_cache_creation +
          m.total_cache_read +
          m.total_output;
        return (
          <HorizontalBar
            key={m.model}
            label={shortModelName(m.model)}
            value={total}
            maxValue={max}
            color="bg-chart-5"
            sub={`· ${m.sessions} session${m.sessions !== 1 ? "s" : ""}`}
          />
        );
      })}
    </div>
  );
}

// ── Per-project breakdown ─────────────────────────────────────────

export function ProjectBreakdown({
  data,
  workingTime,
}: {
  data: TokenByProject[];
  workingTime?: WorkingTimeByProject[];
}) {
  if (data.length === 0) return null;
  const max = Math.max(...data.map((p) => p.total_input + p.total_output));
  const wtMap = new Map(
    workingTime?.map((w) => [w.project_dir, w.working_time_ms]) ?? []
  );
  const maxWt = Math.max(
    ...(workingTime?.map((w) => w.working_time_ms) ?? [0])
  );

  return (
    <div className="space-y-4">
      {data.map((p) => {
        const wt = wtMap.get(p.project_dir);
        return (
          <div key={p.project_dir} className="space-y-1.5">
            <HorizontalBar
              label={shortProjectName(p.project_dir)}
              value={p.total_input + p.total_output}
              maxValue={max}
              color="bg-chart-6"
              sub="tokens"
            />
            {wt != null && wt > 0 && (
              <div className="pl-0">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-transparent">
                    {shortProjectName(p.project_dir)}
                  </span>
                  <span className="ml-2 shrink-0 font-mono text-muted-foreground tabular-nums">
                    {formatDuration(wt)} working
                  </span>
                </div>
                <div className="h-2 w-full rounded-full bg-muted/60">
                  <div
                    className="h-2 rounded-full transition-all bg-chart-3/70"
                    style={{ width: `${Math.max((wt / maxWt) * 100, 1)}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
