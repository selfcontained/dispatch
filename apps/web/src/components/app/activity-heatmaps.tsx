import { Fragment, useMemo } from "react";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { ActiveHoursCell, ActivityRange } from "@/hooks/use-activity";

// ── Heatmap ─────────────────────────────────────────────────────────

const DAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
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

function buildHeatmapGrid(data: Array<{ day: string; count: number }>): {
  cells: HeatmapCell[][];
  months: Array<{ label: string; col: number }>;
  max: number;
} {
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
          label: inFuture
            ? dateLabel
            : `${dateLabel}: ${count} event${count !== 1 ? "s" : ""}`,
        });

        if (cursor.getMonth() !== lastMonth && dow <= 3) {
          months.push({
            label: MONTH_NAMES[cursor.getMonth()],
            col: cols.length,
          });
          lastMonth = cursor.getMonth();
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    cols.push(week);
  }

  return { cells: cols, months, max: max || 1 };
}

export function Heatmap({
  data,
}: {
  data: Array<{ day: string; count: number }>;
}) {
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
                      cell.date
                        ? intensityClass(cell.count, max)
                        : "bg-transparent"
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

// ── Active Hours Grid ──────────────────────────────────────────────

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

export function ActiveHoursGrid({
  data,
  range,
}: {
  data: ActiveHoursCell[];
  range: ActivityRange;
}) {
  const cellMap = useMemo(
    () => new Map(data.map((cell) => [`${cell.dayOfWeek}:${cell.hour}`, cell])),
    [data]
  );
  const max = Math.max(...data.map((cell) => cell.avgPerWeek), 0.01);
  const cadenceLabel =
    range === "daily"
      ? "events"
      : range === "7d"
        ? "events"
        : "avg events / week";

  return (
    <div className="space-y-3">
      <ScrollArea
        style={{ maxWidth: "calc(100vw - 24px)" }}
        className="max-w-full"
      >
        <div className="grid w-max grid-cols-[56px_repeat(24,28px)] gap-x-1.5 gap-y-2 pb-2">
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
                  range === "daily" || range === "7d"
                    ? `${ACTIVE_HOURS_DAY_LABELS[dayOfWeek]} ${formatHour(hour)}: ${cell.count} active events`
                    : `${ACTIVE_HOURS_DAY_LABELS[dayOfWeek]} ${formatHour(hour)}: ${cell.avgPerWeek} avg events/week (${cell.count} total)`;
                return (
                  <div
                    key={`${dayOfWeek}-${hour}`}
                    title={title}
                    data-testid={
                      dayOfWeek === 1 && hour === 9
                        ? "active-hours-cell-sample"
                        : undefined
                    }
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
