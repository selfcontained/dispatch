import { useId } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  parseVisualization,
  parseVisualizationGroup,
  type ChartData,
  type MetricData,
} from "@dispatch/shared";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Card } from "@/components/ui/card";
import "./visualization-block.css";

const exact = (value: number | null) =>
  value === null ? "Missing" : String(value);
const short = (value: number) =>
  new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
function Metadata({ data }: { data: MetricData | ChartData }) {
  return (
    <p className="text-[11px] text-muted-foreground break-words">
      {data.dataKind}
      {data.asOf ? ` · ${data.asOf}` : ""}
      {data.source ? ` · Source: ${data.source}` : ""}
    </p>
  );
}
export function VisualizationBlock({
  kind,
  data,
}: {
  kind: "metric" | "chart" | "visualization_group";
  data: unknown;
}) {
  try {
    // Scheduling intent is service metadata, not part of the public payload.
    const { delivery: _delivery, ...payload } = (data ?? {}) as Record<
      string,
      unknown
    >;
    if (kind === "visualization_group") {
      const group = parseVisualizationGroup(payload);
      const metrics = group.items[0].kind === "metric";
      return (
        <section
          className="visualization-group w-full min-w-0"
          style={{
            maxWidth: metrics
              ? Math.min(group.items.length, 4) * 240 +
                (Math.min(group.items.length, 4) - 1) * 12
              : undefined,
          }}
          aria-label={
            group.title ?? (metrics ? "Related metrics" : "Related charts")
          }
        >
          {group.title && (
            <h3 className="text-sm font-medium mb-2">{group.title}</h3>
          )}
          <div
            data-count={group.items.length}
            className={
              metrics ? "visualization-metric-grid" : "visualization-chart-grid"
            }
          >
            {group.items.map((item, index) =>
              item.kind === "metric" ? (
                <MetricCard key={index} data={item.data} />
              ) : (
                <ChartCard key={index} data={item.data} />
              )
            )}
          </div>
        </section>
      );
    }
    if (kind === "metric")
      return <MetricCard data={parseVisualization("metric", payload)} />;
    return <ChartCard data={parseVisualization("chart", payload)} />;
  } catch {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        This visualization is invalid or uses an unsupported version.
      </p>
    );
  }
}
function MetricCard({ data }: { data: MetricData }) {
  return (
    <Card
      className="visualization-block metric-tile w-full max-w-[240px] min-w-0 border-t-2 border-t-[var(--graph-cyan)] p-3 space-y-2"
      data-kind="metric-card"
    >
      <div className="space-y-2">
        <div className="min-w-0">
          <h3 className="text-xs text-muted-foreground break-words">
            {data.title}
          </h3>
          <p
            className="font-semibold tabular-nums text-3xl break-all"
            title={exact(data.value)}
          >
            {data.value === null ? "Missing" : short(data.value)}{" "}
            <span className="text-xs font-normal text-muted-foreground">
              {data.unit}
            </span>
          </p>
        </div>
        {data.comparison && (
          <p className="text-xs">
            {exact(data.comparison.value)} {data.unit} · {data.comparison.label}
          </p>
        )}
      </div>
      {data.description && (
        <p className="text-xs break-words">{data.description}</p>
      )}
      {data.value !== null && (
        <span className="sr-only">
          Exact value: {exact(data.value)} {data.unit}
        </span>
      )}
      <Metadata data={data} />
    </Card>
  );
}
function ChartCard({ data }: { data: ChartData }) {
  const ranged = data.type === "interval" || data.type === "timeline";
  let running: number | null = 0;
  const rows = data.points.map((point) => {
    const start = running;
    if (data.type === "waterfall")
      running =
        running === null || point.values[0] === null
          ? null
          : running + point.values[0];
    return {
      ...point,
      ...Object.fromEntries(point.values.map((v, i) => [`v${i}`, v])),
      range: ranged
        ? point.values[0] === null
          ? null
          : point.values
        : point.values[0] === null || start === null || running === null
          ? null
          : [start, running],
      start,
      end: running,
    };
  });
  const config = Object.fromEntries(
    data.series.map((s, i) => [
      `v${i}`,
      { label: s.label, color: `var(--graph-${s.color})` },
    ])
  );
  const all = data.points
    .flatMap((p) => p.values)
    .filter((v): v is number => v !== null);
  if (data.type === "waterfall") {
    all.length = 0;
    all.push(
      ...rows
        .flatMap((r) => [r.start, r.end])
        .filter((v): v is number => v !== null)
    );
  }
  const scaleMin = Math.min(0, ...all);
  const scaleMax = Math.max(0, ...all);
  const domain: [number, number] = [
    scaleMin,
    scaleMax === scaleMin ? scaleMin + 1 : scaleMax,
  ];
  const tick = { fill: "hsl(var(--muted-foreground))", fontSize: 10 };
  const axes = (
    <>
      <CartesianGrid vertical={false} />
      <XAxis
        dataKey="label"
        tickLine={false}
        axisLine={false}
        tick={tick}
        tickFormatter={(v) =>
          String(v).length > 14 ? `${String(v).slice(0, 12)}…` : String(v)
        }
      />
      <YAxis
        width={40}
        tickLine={false}
        axisLine={false}
        tick={tick}
        tickFormatter={short}
        domain={domain}
      />
      <ChartTooltip content={<ChartTooltipContent />} />
    </>
  );
  const series = data.series.map((s, i) => ({
    s,
    key: `v${i}`,
    color: `var(--color-v${i})`,
  }));
  let chart;
  switch (data.type) {
    case "line":
      chart = (
        <LineChart data={rows} accessibilityLayer>
          {axes}
          {series.map(({ key, color }, i) => (
            <Line
              key={key}
              dataKey={key}
              type="linear"
              stroke={color}
              strokeWidth={2}
              strokeDasharray={i ? `${i + 3} ${i + 2}` : undefined}
              dot={{ r: 2 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      );
      break;
    case "area":
      chart = (
        <AreaChart data={rows} accessibilityLayer baseValue={0}>
          {axes}
          {series.map(({ key, color }, i) => (
            <Area
              key={key}
              dataKey={key}
              type="linear"
              stroke={color}
              strokeDasharray={i ? `${i + 3} ${i + 2}` : undefined}
              fill={color}
              fillOpacity={0.12}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      );
      break;
    case "scatter":
      chart = (
        <ScatterChart accessibilityLayer>
          <CartesianGrid />
          <XAxis
            dataKey="x"
            type="number"
            name={data.xLabel}
            tick={tick}
            domain={[
              Math.min(0, ...rows.map((r) => r.x ?? 0)),
              Math.max(1, ...rows.map((r) => r.x ?? 0)),
            ]}
          />
          <YAxis
            dataKey="y"
            width={40}
            type="number"
            tick={tick}
            domain={domain}
            tickFormatter={short}
          />
          <ChartTooltip content={<ChartTooltipContent />} />
          {series.map(({ key, color, s }) => (
            <Scatter
              key={key}
              name={s.label}
              data={rows
                .filter((r) => r[key as keyof typeof r] !== null)
                .map((r) => ({
                  x: r.x,
                  y: r[key as keyof typeof r],
                  label: r.label,
                }))}
              fill={color}
              isAnimationActive={false}
            />
          ))}
        </ScatterChart>
      );
      break;
    case "interval":
    case "timeline":
      chart = (
        <BarChart data={rows} layout="vertical" accessibilityLayer>
          <CartesianGrid horizontal={false} />
          <XAxis
            type="number"
            tick={tick}
            domain={domain}
            tickFormatter={short}
          />
          <YAxis
            dataKey="label"
            interval={0}
            type="category"
            width={85}
            tick={tick}
            tickFormatter={(v) => String(v).slice(0, 14)}
          />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar
            dataKey="range"
            name={`${data.series[0].label} [start, end]`}
            fill={`var(--graph-${data.series[0].color})`}
            isAnimationActive={false}
          />
        </BarChart>
      );
      break;
    case "waterfall":
      chart = (
        <BarChart data={rows} accessibilityLayer>
          {axes}
          <ReferenceLine y={0} />
          <Bar
            dataKey="range"
            name="Running total [start, end]"
            fill={`var(--graph-${data.series[0].color})`}
            isAnimationActive={false}
          />
        </BarChart>
      );
      break;
    case "bullet":
      chart = (
        <ComposedChart data={rows} layout="vertical" accessibilityLayer>
          <CartesianGrid horizontal={false} />
          <XAxis type="number" tick={tick} domain={domain} />
          <YAxis
            interval={0}
            type="category"
            dataKey="label"
            width={85}
            tick={tick}
          />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar
            dataKey="v0"
            name={data.series[0].label}
            fill={`var(--graph-${data.series[0].color})`}
            barSize={12}
            isAnimationActive={false}
          />
          <Line
            dataKey="v1"
            name={data.series[1].label}
            stroke="none"
            dot={{ r: 4, fill: `var(--graph-${data.series[1].color})` }}
            isAnimationActive={false}
          />
        </ComposedChart>
      );
      break;
    default:
      chart = (
        <BarChart
          data={rows}
          accessibilityLayer
          barGap={2}
          barCategoryGap={data.type === "histogram" ? "0%" : "12%"}
        >
          {axes}
          {series.map(({ key, color }) => (
            <Bar
              key={key}
              dataKey={key}
              fill={color}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      );
  }
  const headerCells = ranged
    ? ["Start", "End"]
    : data.series.map((s) => s.label);
  return (
    <Card
      className="visualization-block max-w-2xl min-w-0 w-full p-3 space-y-2"
      data-kind="chart-card"
      data-chart-type={data.type}
    >
      <div>
        <h3 className="text-sm font-medium break-words">{data.title}</h3>
        <p className="text-[11px] text-muted-foreground break-words">
          {data.xLabel}
          {data.xUnit ? ` (${data.xUnit})` : ""} · {data.unit}
        </p>
      </div>
      {data.description && (
        <p className="text-xs break-words">{data.description}</p>
      )}
      {!rows.length ? (
        <p className="text-xs text-muted-foreground py-4">
          No data to display.
        </p>
      ) : data.type === "heatmap" ? (
        <HeatmapPlot data={data} min={scaleMin} max={scaleMax} />
      ) : (
        <div className="max-h-64 overflow-y-auto">
          <ChartContainer
            config={config}
            style={{
              height:
                ranged || data.type === "bullet"
                  ? Math.max(128, rows.length * 24 + 32)
                  : 128,
            }}
            className="w-full aspect-auto [&_.recharts-surface]:focus-visible:outline [&_.recharts-surface]:focus-visible:outline-2"
          >
            {chart}
          </ChartContainer>
        </div>
      )}
      {data.type !== "heatmap" && (
        <ul
          aria-label="Chart series"
          className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]"
        >
          {data.series.map((s, i) => (
            <li key={s.id} className="flex gap-1.5 items-center">
              <span
                aria-hidden="true"
                className="h-0.5 w-3"
                style={{ background: `var(--graph-${s.color})` }}
              />
              {s.label}
              {i > 0 && (data.type === "line" || data.type === "area")
                ? " (dashed)"
                : ""}
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary className="text-[11px] cursor-pointer">
          View exact data
        </summary>
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left mt-2">
            <caption className="sr-only">
              {data.title}. Exact plotted values in {data.unit}. Null means
              missing.
            </caption>
            <thead>
              <tr>
                <th scope="col">{data.xLabel}</th>
                {data.type === "scatter" && (
                  <th scope="col">x ({data.xUnit})</th>
                )}
                {data.type === "histogram" && (
                  <>
                    <th scope="col">Bin start ({data.xUnit})</th>
                    <th scope="col">Bin end ({data.xUnit})</th>
                  </>
                )}
                {headerCells.map((name, i) => (
                  <th scope="col" key={i}>
                    {name} ({data.unit})
                  </th>
                ))}
                {data.type === "waterfall" && (
                  <>
                    <th scope="col">Start ({data.unit})</th>
                    <th scope="col">End ({data.unit})</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((p, i) => (
                <tr key={i} className="border-t">
                  <th scope="row" className="py-1 pr-2 break-words">
                    {p.label}
                  </th>
                  {data.type === "scatter" && <td>{exact(p.x ?? null)}</td>}
                  {data.type === "histogram" && (
                    <>
                      <td>{exact(p.from ?? null)}</td>
                      <td>{exact(p.to ?? null)}</td>
                    </>
                  )}
                  {p.values.map((v, j) => (
                    <td className="pr-2 tabular-nums" key={j}>
                      {exact(v)}
                    </td>
                  ))}
                  {data.type === "waterfall" && (
                    <>
                      <td>
                        {p.values[0] === null ? "Missing" : exact(p.start)}
                      </td>
                      <td>{p.values[0] === null ? "Missing" : exact(p.end)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <Metadata data={data} />
    </Card>
  );
}

function HeatmapPlot({
  data,
  min,
  max,
}: {
  data: ChartData;
  min: number;
  max: number;
}) {
  const patternId = `missing-${useId().replace(/:/g, "")}`;
  const width = 620;
  const left = 90;
  const top = 24;
  const rowHeight = 18;
  const cellWidth = (width - left) / data.series.length;
  const height = top + data.points.length * rowHeight;
  return (
    <div className="space-y-2">
      <div className="max-h-64 overflow-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          style={{ width: "100%", minWidth: 440, height: height }}
          role="group"
          aria-label={`${data.title} heatmap`}
        >
          <defs>
            <pattern
              id={patternId}
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
            >
              <rect width="6" height="6" fill="hsl(var(--muted))" />
              <path
                d="M0,6 L6,0"
                stroke="hsl(var(--muted-foreground))"
                strokeOpacity="0.4"
              />
            </pattern>
          </defs>
          {data.series.map((series, i) => (
            <text
              key={series.id}
              x={left + (i + 0.5) * cellWidth}
              y={13}
              textAnchor="middle"
              fill="hsl(var(--muted-foreground))"
              fontSize="10"
            >
              {series.label.length > 12
                ? `${series.label.slice(0, 10)}…`
                : series.label}
            </text>
          ))}
          {data.points.map((point, row) => (
            <g key={row}>
              <text
                x={left - 8}
                y={top + (row + 0.5) * rowHeight + 3}
                textAnchor="end"
                fill="hsl(var(--muted-foreground))"
                fontSize="10"
              >
                {point.label.length > 13
                  ? `${point.label.slice(0, 11)}…`
                  : point.label}
              </text>
              {point.values.map((value, column) => {
                const percentage =
                  value === null
                    ? 0
                    : 8 + 92 * ((value - min) / (max - min || 1));
                const label = `${point.label}, ${data.series[column].label}: ${exact(value)} ${data.unit}`;
                return (
                  <rect
                    key={column}
                    x={left + column * cellWidth}
                    y={top + row * rowHeight}
                    width={cellWidth}
                    height={rowHeight}
                    stroke="hsl(var(--card))"
                    strokeWidth="0.6"
                    fill={
                      value === null
                        ? `url(#${patternId})`
                        : `color-mix(in srgb, var(--graph-cyan) ${percentage}%, hsl(var(--background)))`
                    }
                    tabIndex={0}
                    role="img"
                    aria-label={label}
                  >
                    <title>{label}</title>
                  </rect>
                );
              })}
            </g>
          ))}
        </svg>
      </div>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span>{exact(min)}</span>
        <span
          aria-hidden="true"
          className="h-1.5 w-28"
          style={{
            background:
              "linear-gradient(to right, color-mix(in srgb, var(--graph-cyan) 8%, hsl(var(--background))), var(--graph-cyan))",
          }}
        />
        <span>
          {exact(max)} {data.unit}
        </span>
        <span className="ml-auto">▨ Missing</span>
      </div>
    </div>
  );
}
