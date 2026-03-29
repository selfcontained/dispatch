import { useMemo } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  XAxis,
} from "recharts";

import { ScrollArea } from "@/components/ui/scroll-area";
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
  useActivityHeatmap,
  useActivityStats,
  useDailyStatus,
  type DailyStatusEntry,
} from "@/hooks/use-activity";

type ActivityPaneProps = {
  open: boolean;
  onClose: () => void;
};

// ── Helpers ─────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return "0s";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

function formatDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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

// ── Stat card ───────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/40 px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-foreground">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

// ── Heatmap ─────────────────────────────────────────────────────────

const DAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function intensityClass(count: number, max: number): string {
  if (count === 0) return "bg-muted/60";
  const ratio = count / max;
  if (ratio <= 0.25) return "bg-emerald-900/50";
  if (ratio <= 0.5) return "bg-emerald-700/60";
  if (ratio <= 0.75) return "bg-emerald-500/70";
  return "bg-emerald-400";
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
    <div className="overflow-hidden">
      <div className="flex pl-8 mb-1">
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

      <div className="flex gap-0">
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

      <div className="mt-2 flex items-center gap-1.5 pl-8 text-[10px] text-muted-foreground">
        <span>Less</span>
        <div className="h-[11px] w-[11px] rounded-[2px] bg-muted/60" />
        <div className="h-[11px] w-[11px] rounded-[2px] bg-emerald-900/50" />
        <div className="h-[11px] w-[11px] rounded-[2px] bg-emerald-700/60" />
        <div className="h-[11px] w-[11px] rounded-[2px] bg-emerald-500/70" />
        <div className="h-[11px] w-[11px] rounded-[2px] bg-emerald-400" />
        <span>More</span>
      </div>
    </div>
  );
}

// ── Daily stacked bar chart (recharts) ──────────────────────────────

function fillGaps(data: DailyStatusEntry[]): DailyStatusEntry[] {
  if (data.length < 2) return data;
  const filled: DailyStatusEntry[] = [];
  const dataMap = new Map(data.map((d) => [d.day, d]));
  const start = new Date(data[0].day + "T00:00:00");
  const end = new Date(data[data.length - 1].day + "T00:00:00");
  const cursor = new Date(start);
  while (cursor <= end) {
    const iso = cursor.toISOString().slice(0, 10);
    filled.push(dataMap.get(iso) ?? { day: iso });
    cursor.setDate(cursor.getDate() + 1);
  }
  return filled;
}

function DailyStackedBarChart({ data: rawData }: { data: DailyStatusEntry[] }) {
  const chartData = useMemo(() => {
    const filled = fillGaps(rawData);
    return filled.map((d) => ({
      day: d.day,
      label: formatDate(d.day),
      working: msToMinutes(d.working ?? 0),
      blocked: msToMinutes(d.blocked ?? 0),
      waiting_user: msToMinutes(d.waiting_user ?? 0),
    }));
  }, [rawData]);

  if (chartData.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        Not enough data yet
      </div>
    );
  }

  return (
    <ChartContainer config={chartConfig} className="aspect-[2.5/1] w-full">
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
        <ChartLegend content={<ChartLegendContent />} />
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

// ── Main pane ───────────────────────────────────────────────────────

export function ActivityPane({ open, onClose }: ActivityPaneProps): JSX.Element {
  const { data: heatmapData } = useActivityHeatmap();
  const { data: stats } = useActivityStats();
  const { data: dailyStatus } = useDailyStatus(30);

  const hasData = stats && (stats.totalWorkingMs > 0 || stats.avgBlockedMs > 0 || stats.avgWaitingMs > 0);

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
          <div className="flex h-12 shrink-0 items-center border-b border-border px-5">
            <span className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Activity
            </span>
            <DialogPrimitive.Close className="ml-auto rounded-sm p-1 opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring">
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </div>

          {/* Body */}
          <ScrollArea className="flex-1">
            <div className="mx-auto max-w-3xl space-y-8 px-5 py-6 md:px-8">
              {/* Stats row */}
              {stats && hasData && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <StatCard
                    label="Total working time"
                    value={formatDuration(stats.totalWorkingMs)}
                  />
                  <StatCard
                    label="Avg blocked time"
                    value={formatDuration(stats.avgBlockedMs)}
                    sub={`${stats.blockedRatio}% of total time`}
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

              {/* Heatmap */}
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

              {/* Daily status bar chart */}
              {dailyStatus && dailyStatus.length > 0 && (
                <div>
                  <h2 className="mb-3 text-sm font-medium text-foreground">
                    Daily status breakdown (last 30 days)
                  </h2>
                  <DailyStackedBarChart data={dailyStatus} />
                </div>
              )}

              {/* Empty state */}
              {stats && !hasData && (!heatmapData || heatmapData.length === 0) && (
                <div className="py-12 text-center text-sm text-muted-foreground">
                  No activity yet. Stats will appear here as agents run.
                </div>
              )}
            </div>
          </ScrollArea>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
