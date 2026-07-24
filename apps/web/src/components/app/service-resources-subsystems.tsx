import { useId, useState } from "react";
import { ChevronDown, ChevronRight, Server } from "lucide-react";
import { Area, AreaChart, YAxis } from "recharts";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import type {
  ResourceSample,
  SubsystemResourceSample,
  SubsystemSnapshot,
} from "@/hooks/use-service-resources";
import {
  formatMs,
  metadataLabel,
  stateBadgeVariant,
  stateLabel,
} from "./service-resources-format";

function reasonLabel(reason: SubsystemSnapshot["statusReason"]): string | null {
  if (reason === "stuck") return "A run exceeded twice its expected cadence.";
  if (reason === "stale") return "No recent successful run was observed.";
  if (reason === "failure") return "The latest observed operation failed.";
  return null;
}

type SubsystemStat = {
  key: string;
  label: string;
  value: string;
  isFailure: boolean;
  historyValue: (sample: SubsystemResourceSample) => number | null;
  formatHistoryValue: (value: number) => string;
};

function StatSparkline({
  stat,
  data,
  testId,
}: {
  stat: SubsystemStat;
  data: Array<{ at: number; value: number }>;
  testId: string;
}) {
  const gradientId = `subsystem-trend-${useId().replaceAll(":", "")}`;
  if (data.length < 2) {
    return (
      <div
        className="mt-2 flex h-9 items-end border-b border-dashed border-border/70 pb-1 text-[9px] uppercase tracking-wider text-muted-foreground/70"
        data-testid={testId}
      >
        Collecting trend…
      </div>
    );
  }

  const values = data.map((point) => point.value);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const padding =
    minimum === maximum
      ? Math.max(1, Math.abs(maximum) * 0.05)
      : (maximum - minimum) * 0.12;
  const rangeLabel = `${stat.formatHistoryValue(minimum)} to ${stat.formatHistoryValue(maximum)}`;
  const color = stat.isFailure
    ? "hsl(var(--status-blocked))"
    : "hsl(var(--chart-1))";
  const config = {
    value: { label: stat.label, color },
  } satisfies ChartConfig;

  return (
    <ChartContainer
      config={config}
      className="mt-1.5 h-10 w-full aspect-auto"
      initialDimension={{ width: 140, height: 40 }}
      role="img"
      aria-label={`${stat.label} recent trend, ${rangeLabel}`}
      data-testid={testId}
    >
      <AreaChart data={data} margin={{ top: 3, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.3} />
            <stop offset="95%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <YAxis
          hide
          domain={[Math.max(0, minimum - padding), maximum + padding]}
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke={color}
          fill={`url(#${gradientId})`}
          strokeWidth={1.5}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}

function SubsystemRow({
  subsystem,
  series,
}: {
  subsystem: SubsystemSnapshot;
  series: ResourceSample[];
}) {
  const [expanded, setExpanded] = useState(false);
  const statusReason = reasonLabel(subsystem.statusReason);
  const stats: SubsystemStat[] = [
    ...(subsystem.p95DurationMs === null
      ? []
      : [
          {
            key: "p95-duration",
            label: "p95 duration",
            value: formatMs(subsystem.p95DurationMs),
            isFailure: false,
            historyValue: (sample: SubsystemResourceSample) =>
              sample.p95DurationMs,
            formatHistoryValue: formatMs,
          },
        ]),
    ...(subsystem.failures === 0
      ? []
      : [
          {
            key: "failures",
            label: "Failures",
            value: subsystem.failures.toLocaleString(),
            isFailure: true,
            historyValue: (sample: SubsystemResourceSample) => sample.failures,
            formatHistoryValue: (value: number) => value.toLocaleString(),
          },
        ]),
    ...Object.entries(subsystem.metadata).map(([key, value]) => ({
      key,
      label: metadataLabel(key),
      value: value.toLocaleString(),
      isFailure: false,
      historyValue: (sample: SubsystemResourceSample) =>
        sample.metadata[key] ?? null,
      formatHistoryValue: (historyValue: number) =>
        historyValue.toLocaleString(),
    })),
  ];
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        className="grid w-full grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 md:grid-cols-[minmax(12rem,1.4fr)_minmax(7rem,0.6fr)_minmax(7rem,0.6fr)_5.5rem]"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        data-testid={`subsystem-${subsystem.id}`}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-sm font-medium">
            {subsystem.label}
          </span>
        </span>
        <span className="hidden text-xs text-muted-foreground md:block">
          {subsystem.lastDurationMs === null
            ? "—"
            : formatMs(subsystem.lastDurationMs)}
        </span>
        <span className="hidden text-xs text-muted-foreground md:block">
          {subsystem.inFlight > 0
            ? `${subsystem.inFlight} in flight`
            : subsystem.runs > 0
              ? `${subsystem.runs} ${subsystem.runs === 1 ? "run" : "runs"}`
              : subsystem.state === "healthy"
                ? "Active"
                : "Waiting"}
        </span>
        <Badge
          className="justify-self-end"
          variant={stateBadgeVariant(subsystem.state)}
        >
          {stateLabel(subsystem.state)}
        </Badge>
      </button>
      {expanded && (
        <div className="bg-muted/20 px-4 pb-4 pl-10 text-xs text-muted-foreground">
          <p>{subsystem.description}</p>
          {statusReason && (
            <p className="mt-2 text-status-waiting">{statusReason}</p>
          )}
          {stats.length > 0 && (
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {stats.map((stat) => (
                <div
                  key={stat.key}
                  className="rounded-md border border-border/80 bg-background/40 px-3 pb-2 pt-2 shadow-sm"
                >
                  <span className="block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {stat.label}
                  </span>
                  <span
                    className={`mt-0.5 block text-sm font-semibold tabular-nums ${
                      stat.isFailure ? "text-status-blocked" : "text-foreground"
                    }`}
                  >
                    {stat.value}
                  </span>
                  <StatSparkline
                    stat={stat}
                    data={series.flatMap((sample) => {
                      const history = sample.subsystems?.[subsystem.id];
                      if (!history) return [];
                      const value = stat.historyValue(history);
                      return value === null ? [] : [{ at: sample.at, value }];
                    })}
                    testId={`subsystem-stat-trend-${subsystem.id}-${stat.key}`}
                  />
                </div>
              ))}
            </div>
          )}
          {subsystem.lastError && (
            <p className="mt-3 text-status-blocked">{subsystem.lastError}</p>
          )}
        </div>
      )}
    </div>
  );
}

export function ServiceResourcesSubsystems({
  subsystems,
  series,
}: {
  subsystems: SubsystemSnapshot[];
  series: ResourceSample[];
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Server className="h-4 w-4 text-muted-foreground" />
          Runtime health
        </CardTitle>
        <CardDescription className="text-xs">
          Live state for Dispatch loops, dependencies, and connection managers.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <div className="hidden grid-cols-[minmax(12rem,1.4fr)_minmax(7rem,0.6fr)_minmax(7rem,0.6fr)_5.5rem] gap-3 border-y border-border px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground md:grid">
          <span>Subsystem</span>
          <span>Duration</span>
          <span>Activity</span>
          <span className="text-right">State</span>
        </div>
        {subsystems.map((subsystem) => (
          <SubsystemRow
            key={subsystem.id}
            subsystem={subsystem}
            series={series}
          />
        ))}
      </CardContent>
    </Card>
  );
}
