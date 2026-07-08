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
import { formatDate } from "@/components/app/activity-chart-utils";
import { cn } from "@/lib/utils";
import {
  formatDuration,
  formatTokenCount,
  shortProjectName,
} from "@/lib/format";
import type {
  ActivityGranularity,
  AgentsCreatedEntry,
  DailyStatusEntry,
  ProviderQuotaCompletedWindow,
  ProviderQuotaHistorySeries,
  TokenDailyEntry,
  TokenByModel,
  TokenByProject,
  WorkingTimeByProject,
} from "@/hooks/use-activity";

// ── Helpers ─────────────────────────────────────────────────────────

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

// ── Provider quota rollup charts ──────────────────────────────────

type ProviderWindowClass = "shortSession" | "longDuration";

type ProviderQuotaRollupRow = {
  provider: string;
  shortSession: number | null;
  longDuration: number | null;
};

type ProviderQuotaRollupAccumulator = {
  provider: "codex" | "claude";
  shortSession: { total: number; count: number };
  longDuration: { total: number; count: number };
};

const providerWindowConfig: ChartConfig = {
  shortSession: {
    label: "Short session",
    color: "hsl(var(--chart-1))",
  },
  longDuration: {
    label: "Long duration",
    color: "hsl(var(--chart-2))",
  },
};

const leftOnTableConfig: ChartConfig = {
  codexShortSession: {
    label: "Codex short",
    color: "hsl(var(--chart-1))",
  },
  codexLongDuration: {
    label: "Codex long",
    color: "hsl(var(--chart-2))",
  },
  claudeShortSession: {
    label: "Claude short",
    color: "hsl(var(--chart-3))",
  },
  claudeLongDuration: {
    label: "Claude long",
    color: "hsl(var(--chart-4))",
  },
};

type LeftOnTableBarKey =
  | "codexShortSession"
  | "codexLongDuration"
  | "claudeShortSession"
  | "claudeLongDuration";

type LeftOnTableRow = Record<string, string | number> & {
  day: string;
  label: string;
  codexShortSessionTotal?: number;
  codexShortSessionCount?: number;
  codexLongDurationTotal?: number;
  codexLongDurationCount?: number;
  claudeShortSessionTotal?: number;
  claudeShortSessionCount?: number;
  claudeLongDurationTotal?: number;
  claudeLongDurationCount?: number;
};

function providerName(provider: "codex" | "claude"): string {
  return provider === "codex" ? "Codex" : "Claude";
}

function quotaWindowClass(input: {
  kind: string;
  scope?: string;
  windowSeconds?: number | null;
}): ProviderWindowClass | null {
  if (input.scope && input.scope !== "account") return null;
  if (input.kind === "credits") return null;
  if (input.kind === "session") return "shortSession";
  if (input.kind === "weekly") return "longDuration";
  const windowSeconds = input.windowSeconds ?? null;
  if (windowSeconds !== null) {
    return windowSeconds <= 6 * 60 * 60 ? "shortSession" : "longDuration";
  }
  return null;
}

function createQuotaRollups(): Map<
  "codex" | "claude",
  ProviderQuotaRollupAccumulator
> {
  return new Map([
    [
      "codex",
      {
        provider: "codex",
        shortSession: { total: 0, count: 0 },
        longDuration: { total: 0, count: 0 },
      },
    ],
    [
      "claude",
      {
        provider: "claude",
        shortSession: { total: 0, count: 0 },
        longDuration: { total: 0, count: 0 },
      },
    ],
  ]);
}

function rollupsToRows(
  rollups: Map<"codex" | "claude", ProviderQuotaRollupAccumulator>
): ProviderQuotaRollupRow[] {
  return Array.from(rollups.values())
    .map((rollup) => ({
      provider: providerName(rollup.provider),
      shortSession:
        rollup.shortSession.count > 0
          ? Math.round(
              (rollup.shortSession.total / rollup.shortSession.count) * 10
            ) / 10
          : null,
      longDuration:
        rollup.longDuration.count > 0
          ? Math.round(
              (rollup.longDuration.total / rollup.longDuration.count) * 10
            ) / 10
          : null,
    }))
    .filter((row) => row.shortSession !== null || row.longDuration !== null);
}

function leftOnTableBarKey(
  provider: "codex" | "claude",
  windowClass: ProviderWindowClass
): LeftOnTableBarKey {
  return `${provider}${windowClass === "shortSession" ? "ShortSession" : "LongDuration"}`;
}

function completedWindowBucket(
  resetsAt: string,
  granularity: ActivityGranularity
): string {
  if (granularity === "hour") {
    return `${resetsAt.slice(0, 13).replace("T", " ")}:00`;
  }
  if (granularity === "month") {
    return `${resetsAt.slice(0, 7)}-01`;
  }
  return resetsAt.slice(0, 10);
}

function finalizeLeftOnTableRows(rows: LeftOnTableRow[]): LeftOnTableRow[] {
  const keys: LeftOnTableBarKey[] = [
    "codexShortSession",
    "codexLongDuration",
    "claudeShortSession",
    "claudeLongDuration",
  ];
  return rows.map((row) => {
    for (const key of keys) {
      const total = row[`${key}Total`];
      const count = row[`${key}Count`];
      if (typeof total === "number" && typeof count === "number") {
        row[key] = Math.round((total / count) * 10) / 10;
      }
      delete row[`${key}Total`];
      delete row[`${key}Count`];
    }
    return row;
  });
}

function ProviderQuotaRollupChart({
  rows,
  emptyLabel,
}: {
  rows: ProviderQuotaRollupRow[];
  emptyLabel: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ChartContainer
        config={providerWindowConfig}
        className="aspect-[1.5/1] sm:aspect-[2.5/1] w-full"
      >
        <BarChart data={rows} barCategoryGap="28%">
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="provider"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
          />
          <YAxis domain={[0, 100]} tickFormatter={(value) => `${value}%`} />
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
                        {providerWindowConfig[name as string]?.label ?? name}
                      </span>
                      <span className="font-mono font-medium text-foreground tabular-nums">
                        {Math.round(Number(value))}%
                      </span>
                    </div>
                  </>
                )}
                labelFormatter={(label) => label as string}
              />
            }
          />
          <ChartLegend
            content={
              <ChartLegendContent className="flex-wrap gap-2 sm:gap-4" />
            }
          />
          <Bar
            dataKey="shortSession"
            fill="var(--color-shortSession)"
            radius={[2, 2, 0, 0]}
          />
          <Bar
            dataKey="longDuration"
            fill="var(--color-longDuration)"
            radius={[2, 2, 0, 0]}
          />
        </BarChart>
      </ChartContainer>
      <div className="grid gap-2 sm:grid-cols-2">
        {rows.map((row) => (
          <div
            key={row.provider}
            className="rounded-md border border-border bg-muted/20 p-3"
          >
            <div className="text-xs font-medium text-foreground">
              {row.provider}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
              <div>
                <div className="text-muted-foreground">Short session avg</div>
                <div className="mt-0.5 font-semibold text-foreground">
                  {row.shortSession === null
                    ? "n/a"
                    : `${Math.round(row.shortSession)}%`}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Long duration avg</div>
                <div className="mt-0.5 font-semibold text-foreground">
                  {row.longDuration === null
                    ? "n/a"
                    : `${Math.round(row.longDuration)}%`}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ProviderQuotaUtilizationChart({
  series,
}: {
  series: ProviderQuotaHistorySeries[];
  granularity: ActivityGranularity;
}) {
  const rows = useMemo(() => {
    const rollups = createQuotaRollups();
    for (const entry of series) {
      const windowClass = quotaWindowClass(entry);
      if (!windowClass) continue;
      const rollup = rollups.get(entry.provider);
      if (!rollup) continue;
      for (const point of entry.points) {
        const value = point.avgUsedPercent;
        if (value === null) continue;
        rollup[windowClass].total += value;
        rollup[windowClass].count += 1;
      }
    }
    return rollupsToRows(rollups);
  }, [series]);

  return (
    <ProviderQuotaRollupChart rows={rows} emptyLabel="No quota history yet" />
  );
}

export function ProviderQuotaLeftOnTableChart({
  completedWindows,
  granularity,
}: {
  completedWindows: ProviderQuotaCompletedWindow[];
  granularity: ActivityGranularity;
}) {
  const { rows, chartData, barKeys } = useMemo(() => {
    const rollups = createQuotaRollups();
    const buckets = new Map<string, LeftOnTableRow>();
    const visibleKeys = new Set<LeftOnTableBarKey>();
    for (const window of completedWindows) {
      if (window.unusedPercent === null) continue;
      const windowClass = quotaWindowClass(window);
      if (!windowClass) continue;
      const rollup = rollups.get(window.provider);
      if (!rollup) continue;
      rollup[windowClass].total += window.unusedPercent;
      rollup[windowClass].count += 1;

      const key = leftOnTableBarKey(window.provider, windowClass);
      visibleKeys.add(key);
      const day = completedWindowBucket(window.resetsAt, granularity);
      const row =
        buckets.get(day) ??
        (() => {
          const next: LeftOnTableRow = {
            day,
            label: formatBucketLabel(day, granularity),
          };
          buckets.set(day, next);
          return next;
        })();
      const totalKey = `${key}Total` as const;
      const countKey = `${key}Count` as const;
      row[totalKey] = (row[totalKey] ?? 0) + window.unusedPercent;
      row[countKey] = (row[countKey] ?? 0) + 1;
    }
    const sortedRows = Array.from(buckets.values()).sort((a, b) =>
      a.day.localeCompare(b.day)
    );
    const keys: LeftOnTableBarKey[] = [
      "codexShortSession",
      "codexLongDuration",
      "claudeShortSession",
      "claudeLongDuration",
    ];
    return {
      rows: rollupsToRows(rollups),
      chartData: finalizeLeftOnTableRows(sortedRows),
      barKeys: keys.filter((key) => visibleKeys.has(key)),
    };
  }, [completedWindows, granularity]);

  if (rows.length === 0 || chartData.length === 0 || barKeys.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        No completed windows yet
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {rows.map((row) => (
          <div
            key={row.provider}
            className="rounded-md border border-border bg-muted/20 p-3"
          >
            <div className="text-xs font-medium text-foreground">
              {row.provider}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
              <div>
                <div className="text-muted-foreground">
                  Short session unused avg
                </div>
                <div className="mt-0.5 font-semibold text-foreground">
                  {row.shortSession === null
                    ? "n/a"
                    : `${Math.round(row.shortSession)}%`}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">
                  Long duration unused avg
                </div>
                <div className="mt-0.5 font-semibold text-foreground">
                  {row.longDuration === null
                    ? "n/a"
                    : `${Math.round(row.longDuration)}%`}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
      <ChartContainer
        config={leftOnTableConfig}
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
          <YAxis domain={[0, 100]} tickFormatter={(value) => `${value}%`} />
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
                        {leftOnTableConfig[name as string]?.label ?? name}
                      </span>
                      <span className="font-mono font-medium text-foreground tabular-nums">
                        {Math.round(Number(value))}%
                      </span>
                    </div>
                  </>
                )}
                labelFormatter={(label) => label as string}
              />
            }
          />
          <ChartLegend
            content={
              <ChartLegendContent className="flex-wrap gap-2 sm:gap-4" />
            }
          />
          {barKeys.map((key) => (
            <Bar
              key={key}
              dataKey={key}
              fill={leftOnTableConfig[key]?.color}
              radius={[2, 2, 0, 0]}
            />
          ))}
        </BarChart>
      </ChartContainer>
    </div>
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
