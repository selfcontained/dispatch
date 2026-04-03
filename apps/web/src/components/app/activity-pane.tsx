import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { AgentHistoryTab } from "@/components/app/agent-history-tab";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from "recharts";

import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { cn } from "@/lib/utils";
import { formatDuration, formatTokenCount, shortProjectName } from "@/lib/format";
import { StatCard } from "@/components/app/stat-card";
import {
  ACTIVITY_RANGES,
  useActiveHours,
  useActivityHeatmap,
  useActivityStats,
  useAgentsCreated,
  useDailyStatus,
  useTokenStats,
  useTokenDaily,
  useTokenByModel,
  useTokenByProject,
  useWorkingTimeByProject,
  rangeLabel,
  type ActivityGranularity,
  type AgentsCreatedEntry,
  type ActiveHoursCell,
  type ActivityRange,
  type DailyStatusEntry,
  type TokenDailyEntry,
  type TokenStats,
  type TokenByModel,
  type TokenByProject,
  type WorkingTimeByProject,
} from "@/hooks/use-activity";

type ActivityPaneProps = {
  open: boolean;
  onClose: () => void;
  initialTab?: "metrics" | "history";
  onTabChange?: (tab: string) => void;
};

// ── Helpers ─────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatBucketLabel(iso: string, granularity: ActivityGranularity): string {
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

// ── Heatmap ─────────────────────────────────────────────────────────

const DAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function intensityClass(count: number, max: number): string {
  if (count === 0) return "bg-muted/60";
  const ratio = count / max;
  if (ratio <= 0.25) return "bg-status-working/25";
  if (ratio <= 0.5) return "bg-status-working/45";
  if (ratio <= 0.75) return "bg-status-working/65";
  return "bg-status-working/90";
}

type HeatmapCell = { date: string; count: number; label: string };

function buildHeatmapGrid(
  data: Array<{ day: string; count: number }>
): { cells: HeatmapCell[][]; months: Array<{ label: string; col: number }>; max: number } {
  const countMap = new Map<string, number>();
  let max = 0;
  for (const d of data) {
    countMap.set(d.day, d.count);
    if (d.count > max) max = d.count;
  }

  const today = new Date();
  const year = today.getFullYear();
  // Start from Jan 1, aligned to the preceding Sunday
  const jan1 = new Date(year, 0, 1);
  const start = new Date(jan1);
  start.setDate(start.getDate() - start.getDay());
  // End at Dec 31, aligned to the following Saturday
  const dec31 = new Date(year, 11, 31);
  const end = new Date(dec31);
  end.setDate(end.getDate() + (6 - end.getDay()));

  const cols: HeatmapCell[][] = [];
  const months: Array<{ label: string; col: number }> = [];
  let lastMonth = -1;
  const cursor = new Date(start);

  while (cursor <= end) {
    const week: HeatmapCell[] = [];
    for (let dow = 0; dow < 7; dow++) {
      const inYear = cursor.getFullYear() === year;
      const inFuture = cursor > today;
      if (!inYear) {
        week.push({ date: "", count: 0, label: "" });
      } else {
        const iso = cursor.toISOString().slice(0, 10);
        const count = inFuture ? 0 : (countMap.get(iso) ?? 0);
        const dateLabel = cursor.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        });
        week.push({
          date: iso,
          count,
          label: inFuture ? dateLabel : `${dateLabel}: ${count} event${count !== 1 ? "s" : ""}`,
        });

        if (cursor.getMonth() !== lastMonth && dow <= 3) {
          months.push({ label: MONTH_NAMES[cursor.getMonth()], col: cols.length });
          lastMonth = cursor.getMonth();
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    cols.push(week);
  }

  return { cells: cols, months, max: max || 1 };
}

function Heatmap({ data }: { data: Array<{ day: string; count: number }> }) {
  const { cells, months, max } = useMemo(() => buildHeatmapGrid(data), [data]);

  return (
    <div className="space-y-2">
      <ScrollArea style={{ maxWidth: "calc(100vw - 24px)" }}>
        <div className="flex pl-8 mb-1 w-max">
          {months.map((m, i) => {
            const nextCol = months[i + 1]?.col ?? cells.length;
            const span = nextCol - m.col;
            return (
              <span
                key={`${m.label}-${m.col}`}
                className="text-[10px] text-muted-foreground"
                style={{ width: `${span * 13}px`, flexShrink: 0 }}
              >
                {span >= 3 ? m.label : ""}
              </span>
            );
          })}
        </div>

        <div className="flex gap-0 w-max pb-2">
          <div className="flex flex-col gap-[2px] pr-1.5 pt-0">
            {DAY_LABELS.map((label, i) => (
              <span
                key={i}
                className="flex h-[11px] items-center text-[10px] leading-none text-muted-foreground"
              >
                {label}
              </span>
            ))}
          </div>

          <div className="flex gap-[2px]">
            {cells.map((week, ci) => (
              <div key={ci} className="flex flex-col gap-[2px]">
                {week.map((cell, ri) => (
                  <div
                    key={ri}
                    title={cell.label}
                    className={cn(
                      "h-[11px] w-[11px] rounded-[2px] transition-colors",
                      cell.date ? intensityClass(cell.count, max) : "bg-transparent"
                    )}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>

      <div className="flex items-center gap-1.5 pl-8 text-[10px] text-muted-foreground">
        <span>Less</span>
        <div className="h-[11px] w-[11px] rounded-[2px] bg-muted/60" />
        <div className="h-[11px] w-[11px] rounded-[2px] bg-status-working/25" />
        <div className="h-[11px] w-[11px] rounded-[2px] bg-status-working/45" />
        <div className="h-[11px] w-[11px] rounded-[2px] bg-status-working/65" />
        <div className="h-[11px] w-[11px] rounded-[2px] bg-status-working/90" />
        <span>More</span>
      </div>
    </div>
  );
}

const ACTIVE_HOURS_DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const ACTIVE_HOURS_DAY_LABELS: Record<number, string> = {
  0: "Sun",
  1: "Mon",
  2: "Tue",
  3: "Wed",
  4: "Thu",
  5: "Fri",
  6: "Sat",
};

function activeHoursIntensity(value: number, max: number): string {
  if (value <= 0) return "bg-muted/40";
  const ratio = value / max;
  if (ratio <= 0.2) return "bg-chart-3/20";
  if (ratio <= 0.4) return "bg-chart-3/40";
  if (ratio <= 0.6) return "bg-chart-3/55";
  if (ratio <= 0.8) return "bg-chart-3/70";
  return "bg-chart-3/90";
}

function formatHour(hour: number): string {
  const suffix = hour >= 12 ? "p" : "a";
  const normalized = hour % 12 === 0 ? 12 : hour % 12;
  return `${normalized}${suffix}`;
}

function ActiveHoursGrid({ data, range }: { data: ActiveHoursCell[]; range: ActivityRange }) {
  const cellMap = useMemo(
    () => new Map(data.map((cell) => [`${cell.dayOfWeek}:${cell.hour}`, cell])),
    [data]
  );
  const max = Math.max(...data.map((cell) => cell.avgPerWeek), 0.01);
  const cadenceLabel = range === "7d" ? "events" : "avg events / week";

  return (
    <div className="space-y-3">
      <ScrollArea style={{ maxWidth: "calc(100vw - 24px)" }} className="max-w-full">
        <div className="grid min-w-[760px] w-max grid-cols-[56px_repeat(24,minmax(0,1fr))] gap-x-1.5 gap-y-2 pb-2">
          <div />
          {Array.from({ length: 24 }, (_, hour) => (
            <div
              key={`label-${hour}`}
              className="text-center text-[10px] font-medium text-muted-foreground"
            >
              {hour % 2 === 0 ? formatHour(hour) : ""}
            </div>
          ))}

          {ACTIVE_HOURS_DAY_ORDER.map((dayOfWeek) => (
            <Fragment key={`row-${dayOfWeek}`}>
              <div className="flex items-center text-xs font-medium text-muted-foreground">
                {ACTIVE_HOURS_DAY_LABELS[dayOfWeek]}
              </div>
              {Array.from({ length: 24 }, (_, hour) => {
                const cell = cellMap.get(`${dayOfWeek}:${hour}`) ?? {
                  dayOfWeek,
                  hour,
                  count: 0,
                  avgPerWeek: 0,
                };
                const title =
                  range === "7d"
                    ? `${ACTIVE_HOURS_DAY_LABELS[dayOfWeek]} ${formatHour(hour)}: ${cell.count} active events`
                    : `${ACTIVE_HOURS_DAY_LABELS[dayOfWeek]} ${formatHour(hour)}: ${cell.avgPerWeek} avg events/week (${cell.count} total)`;
                return (
                  <div
                    key={`${dayOfWeek}-${hour}`}
                    title={title}
                    data-testid={dayOfWeek === 1 && hour === 9 ? "active-hours-cell-sample" : undefined}
                    className={cn(
                      "h-5 rounded-[6px] border border-border/40 transition-colors",
                      activeHoursIntensity(cell.avgPerWeek, max)
                    )}
                  />
                );
              })}
            </Fragment>
          ))}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>

      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span>Less</span>
        <div className="h-2.5 w-5 rounded-full bg-muted/40" />
        <div className="h-2.5 w-5 rounded-full bg-chart-3/20" />
        <div className="h-2.5 w-5 rounded-full bg-chart-3/40" />
        <div className="h-2.5 w-5 rounded-full bg-chart-3/55" />
        <div className="h-2.5 w-5 rounded-full bg-chart-3/70" />
        <div className="h-2.5 w-5 rounded-full bg-chart-3/90" />
        <span>More</span>
        <span className="ml-2">{cadenceLabel}</span>
      </div>
    </div>
  );
}

// ── Daily stacked bar chart (recharts) ──────────────────────────────

function fillGaps<T extends { day: string }>(
  data: T[],
  granularity: ActivityGranularity,
  defaultEntry: (day: string) => T
): T[] {
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

function DailyStackedBarChart({
  data: rawData,
  granularity,
}: {
  data: DailyStatusEntry[];
  granularity: ActivityGranularity;
}) {
  const chartData = useMemo(() => {
    const filled = fillGaps<DailyStatusEntry>(rawData, granularity, (day) => ({ day }));
    return filled.map((d) => ({
      day: d.day,
      label: formatBucketLabel(d.day, granularity),
      working: msToMinutes(d.working ?? 0),
      blocked: msToMinutes(d.blocked ?? 0),
      waiting_user: msToMinutes(d.waiting_user ?? 0),
    }));
  }, [granularity, rawData]);

  if (chartData.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        Not enough data yet
      </div>
    );
  }

  return (
    <ChartContainer config={chartConfig} className="aspect-[1.5/1] sm:aspect-[2.5/1] w-full">
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
        <ChartLegend content={<ChartLegendContent className="flex-wrap gap-2 sm:gap-4" />} />
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

function cacheHitRate(stats: TokenStats): number {
  const totalInput = stats.total_input + stats.total_cache_creation + stats.total_cache_read;
  if (totalInput === 0) return 0;
  return Math.round((stats.total_cache_read / totalInput) * 100);
}

function shortModelName(model: string): string {
  if (model.includes("opus")) return "Opus";
  if (model.includes("sonnet")) return "Sonnet";
  if (model.includes("haiku")) return "Haiku";
  if (model.includes("gpt-5")) return "GPT-5";
  if (model.includes("gpt-4")) return "GPT-4";
  return model;
}

// ── Token daily chart ─────────────────────────────────────────────

const TOKEN_ORDER = ["input_tokens", "cache_read_tokens", "cache_creation_tokens", "output_tokens"];

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

function DailyTokenChart({
  data: rawData,
  granularity,
  agentsCreatedData,
}: {
  data: TokenDailyEntry[];
  granularity: ActivityGranularity;
  agentsCreatedData?: AgentsCreatedEntry[];
}) {
  const chartData = useMemo(() => {
    const filled = fillGaps(rawData, granularity, EMPTY_TOKEN_ENTRY);
    const agentsMap = new Map(agentsCreatedData?.map((d) => [d.day, d.count]) ?? []);
    return filled.map((d) => ({
      ...d,
      label: formatBucketLabel(d.day, granularity),
      agents_created: agentsMap.get(d.day) ?? 0,
    }));
  }, [granularity, rawData, agentsCreatedData]);

  const hasAgentsLine = chartData.some((d) => d.agents_created > 0);

  if (chartData.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        No token data yet
      </div>
    );
  }

  return (
    <ChartContainer config={tokenChartConfig} className="aspect-[1.5/1] sm:aspect-[2.5/1] w-full">
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
        {hasAgentsLine && (
          <YAxis yAxisId="agents" orientation="right" hide />
        )}
        <ChartTooltip
          content={
            <ChartTooltipContent
              indicator="dot"
              formatter={(value, name) => (
                <>
                  <div
                    className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                    style={{
                      backgroundColor: tokenChartConfig[name as string]?.color,
                    }}
                  />
                  <div className="flex flex-1 items-center justify-between gap-8">
                    <span className="text-muted-foreground">
                      {tokenChartConfig[name as string]?.label ?? name}
                    </span>
                    <span className="font-mono font-medium text-foreground tabular-nums">
                      {name === "agents_created"
                        ? String(value)
                        : formatTokenCount(value as number)}
                    </span>
                  </div>
                </>
              )}
              labelFormatter={(label) => label as string}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent className="flex-wrap gap-2 sm:gap-4" />} />
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
          {formatTokenCount(value)}{sub ? ` ${sub}` : ""}
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

function ModelBreakdown({ data }: { data: TokenByModel[] }) {
  if (data.length === 0) return null;
  const max = Math.max(...data.map((m) => m.total_input + m.total_cache_creation + m.total_cache_read + m.total_output));

  return (
    <div className="space-y-3">
      {data.map((m) => {
        const total = m.total_input + m.total_cache_creation + m.total_cache_read + m.total_output;
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

function ProjectBreakdown({
  data,
  workingTime,
}: {
  data: TokenByProject[];
  workingTime?: WorkingTimeByProject[];
}) {
  if (data.length === 0) return null;
  const max = Math.max(...data.map((p) => p.total_input + p.total_output));
  const wtMap = new Map(workingTime?.map((w) => [w.project_dir, w.working_time_ms]) ?? []);
  const maxWt = Math.max(...(workingTime?.map((w) => w.working_time_ms) ?? [0]));

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
                  <span className="text-transparent">{shortProjectName(p.project_dir)}</span>
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

// ── Main pane ───────────────────────────────────────────────────────

type ActivityTab = "metrics" | "history";

export function ActivityPane({ open, onClose, initialTab, onTabChange }: ActivityPaneProps): JSX.Element {
  const [range, setRange] = useState<ActivityRange>("7d");
  const [tab, setTabState] = useState<ActivityTab>(initialTab ?? "metrics");

  useEffect(() => {
    if (open && initialTab) {
      setTabState(initialTab);
    }
  }, [open, initialTab]);

  const setTab = useCallback((newTab: ActivityTab) => {
    setTabState(newTab);
    onTabChange?.(newTab);
  }, [onTabChange]);
  const { data: heatmapData } = useActivityHeatmap();
  const { data: stats } = useActivityStats(range);
  const { data: dailyStatus } = useDailyStatus(range);
  const { data: activeHours } = useActiveHours(range);
  const { data: tokenStats } = useTokenStats(range);
  const { data: tokenDaily } = useTokenDaily(range);
  const { data: tokenByModel } = useTokenByModel(range);
  const { data: tokenByProject } = useTokenByProject(range);
  const { data: agentsCreated } = useAgentsCreated(range);
  const { data: workingTimeByProject } = useWorkingTimeByProject(range);

  const hasData = stats && (stats.totalWorkingMs > 0 || stats.avgBlockedMs > 0 || stats.avgWaitingMs > 0);
  const totalTokens = tokenStats
    ? tokenStats.total_input + tokenStats.total_cache_creation + tokenStats.total_cache_read + tokenStats.total_output
    : 0;
  const hasTokenData = totalTokens > 0;
  const hasActiveHourData = activeHours?.some((cell) => cell.count > 0) ?? false;

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[70] bg-black/70 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="fixed inset-0 md:inset-4 z-[70] flex flex-col overflow-hidden rounded-none md:rounded-sm border border-border bg-card text-foreground shadow-2xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <DialogPrimitive.Title className="sr-only">Activity</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Agent activity and usage overview
          </DialogPrimitive.Description>

          {/* Header */}
          <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-5">
            <div className="flex items-center gap-1">
              {(["metrics", "history"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn(
                    "rounded px-2.5 py-1 text-xs font-medium transition-colors",
                    tab === t
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {t === "metrics" ? "Metrics" : "History"}
                </button>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-2">
              {tab === "metrics" && (
                <Select value={range} onValueChange={(value) => setRange(value as ActivityRange)}>
                  <SelectTrigger
                    className="h-8 w-[132px] bg-muted/30 text-xs"
                    data-testid="activity-range-select"
                    aria-label="Activity time range"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACTIVITY_RANGES.map((option) => (
                      <SelectItem key={option} value={option}>
                        {rangeLabel(option)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <DialogPrimitive.Close className="rounded-sm p-1 opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring">
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </div>

          {/* History tab */}
          {tab === "history" && (
            <ScrollArea className="flex-1 [&>[data-radix-scroll-area-viewport]>div]:!block">
              <AgentHistoryTab range={range} onRangeChange={setRange} />
            </ScrollArea>
          )}

          {/* Metrics tab body */}
          {tab === "metrics" && <ScrollArea className="flex-1">
            <div className="mx-auto max-w-3xl min-w-0 overflow-hidden space-y-6 px-3 pt-4 pb-12 sm:space-y-8 sm:px-5 sm:pt-6 sm:pb-20 md:px-8">
              {/* Token usage stats */}
              {hasTokenData && tokenStats && (
                <div className="flex flex-wrap gap-2 sm:gap-3">
                  <StatCard
                    label="Total tokens"
                    value={formatTokenCount(totalTokens)}
                    sub={`${formatTokenCount(tokenStats.total_output)} output`}
                  />
                  <StatCard
                    label="Cache hit rate"
                    value={`${cacheHitRate(tokenStats)}%`}
                    sub="of input from cache"
                  />
                  <StatCard
                    label="Avg tokens / session"
                    value={
                      tokenStats.total_sessions > 0
                        ? formatTokenCount(Math.round(totalTokens / tokenStats.total_sessions))
                        : "—"
                    }
                  />
                  <StatCard
                    label="Sessions"
                    value={tokenStats.total_sessions}
                    sub={`${tokenStats.total_messages} messages`}
                  />
                  {agentsCreated && agentsCreated.total > 0 && (
                    <StatCard
                      label="Agents created"
                      value={agentsCreated.total}
                    />
                  )}
                </div>
              )}

              {/* Daily token chart + agents created line */}
              {tokenDaily && tokenDaily.days.length > 0 && (
                <div>
                  <h2 className="mb-3 text-sm font-medium text-foreground">
                    Token usage ({rangeLabel(range).toLowerCase()})
                  </h2>
                  <DailyTokenChart
                    data={tokenDaily.days}
                    granularity={tokenDaily.granularity}
                    agentsCreatedData={agentsCreated?.days}
                  />
                </div>
              )}

              {/* Model & project breakdowns side by side */}
              {hasTokenData && (tokenByModel?.length || tokenByProject?.length) ? (
                <div className="grid gap-6 sm:grid-cols-2">
                  {tokenByModel && tokenByModel.length > 0 && (
                    <div>
                      <h2 className="mb-3 text-sm font-medium text-foreground">
                        Tokens by model
                      </h2>
                      <ModelBreakdown data={tokenByModel} />
                    </div>
                  )}
                  {tokenByProject && tokenByProject.length > 0 && (
                    <div>
                      <h2 className="mb-3 text-sm font-medium text-foreground">
                        By project
                      </h2>
                      <ProjectBreakdown data={tokenByProject} workingTime={workingTimeByProject} />
                    </div>
                  )}
                </div>
              ) : null}

              {/* Yearly activity heatmap */}
              <div>
                <h2 className="mb-3 text-sm font-medium text-foreground">
                  Activity this year
                </h2>
                {heatmapData ? (
                  <Heatmap data={heatmapData} />
                ) : (
                  <div className="h-24 animate-pulse rounded-md bg-muted/30" />
                )}
              </div>

              {/* Active hours */}
              {activeHours && activeHours.length > 0 && hasActiveHourData && (
                <div className="min-w-0">
                  <h2 className="mb-1 text-sm font-medium text-foreground">
                    Active hours
                  </h2>
                  <p className="mb-3 text-xs text-muted-foreground">
                    {range === "7d"
                      ? "Active-state events by weekday and hour for the last 7 days."
                      : `Average active-state events per week by weekday and hour for ${rangeLabel(range).toLowerCase()}.`}
                  </p>
                  <ActiveHoursGrid data={activeHours} range={range} />
                </div>
              )}

              {/* Status summary cards */}
              {stats && hasData && (
                <div className="flex flex-wrap gap-2 sm:gap-3">
                  <StatCard
                    label="Total working time"
                    value={formatDuration(stats.totalWorkingMs)}
                  />
                  <StatCard
                    label="Avg blocked time"
                    value={formatDuration(stats.avgBlockedMs)}
                  />
                  <StatCard
                    label="Avg waiting time"
                    value={formatDuration(stats.avgWaitingMs)}
                  />
                  <StatCard
                    label="Busiest day"
                    value={stats.busiestDay ? formatDate(stats.busiestDay) : "—"}
                    sub={stats.busiestDayCount > 0 ? `${stats.busiestDayCount} events` : undefined}
                  />
                </div>
              )}

              {/* Daily status bar chart */}
              {dailyStatus && dailyStatus.days.length > 0 && (
                <div>
                  <h2 className="mb-3 text-sm font-medium text-foreground">
                    Status breakdown ({rangeLabel(range).toLowerCase()})
                  </h2>
                  <DailyStackedBarChart
                    data={dailyStatus.days}
                    granularity={dailyStatus.granularity}
                  />
                </div>
              )}

              {/* Empty state */}
              {stats && !hasData && (!heatmapData || heatmapData.length === 0) && !hasTokenData && (
                <div className="py-12 text-center text-sm text-muted-foreground">
                  No activity yet. Stats will appear here as agents run.
                </div>
              )}
            </div>
          </ScrollArea>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
