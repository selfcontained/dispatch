import { useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import {
  Area,
  AreaChart,
  Scatter,
  ScatterChart,
  ZAxis,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Card } from "@/components/ui/card";
import "./communication-options.css";

const rows = [
  { label: "Mon", observed: 42, planned: 40 },
  { label: "Tue", observed: 56, planned: 50 },
  { label: "Wed", observed: 61, planned: 60 },
  { label: "Thu", observed: 68, planned: 65 },
  { label: "Fri", observed: 74, planned: 70 },
];
const palettes = [
  {
    name: "Neon cyan / pink",
    colors: ["var(--graph-cyan)", "var(--graph-pink)"],
    description: "Dedicated graph palette · cyan + electric pink",
  },
  {
    name: "Neon lime / cyan",
    colors: ["var(--graph-lime)", "var(--graph-cyan)"],
    description: "Dedicated graph palette · acid lime + cyan",
  },
  {
    name: "Theme palette",
    colors: ["hsl(var(--chart-1))", "hsl(var(--chart-2))"],
    description: "Existing selected-theme chart slots 1 + 2",
  },
] as const;
const config = {
  observed: { label: "Observed", color: "var(--review-series-1)" },
  planned: { label: "Planned", color: "var(--review-series-2)" },
};
const options = [
  {
    name: "Compact inline",
    description:
      "Quiet, dense blocks that sit naturally between messages. Best for frequent updates.",
    padding: "p-3",
    height: "h-32",
    metric: "text-2xl",
  },
  {
    name: "Analytical panel",
    description:
      "More room for axes, comparison and exact values. Best for explaining a result.",
    padding: "p-4",
    height: "h-40",
    metric: "text-3xl",
  },
  {
    name: "Presentation card",
    description:
      "A strong headline and generous space. Best for occasional milestones and handoffs.",
    padding: "p-5",
    height: "h-44",
    metric: "text-4xl",
  },
];
function SampleChart({ line, height }: { line: boolean; height: string }) {
  const children = (
    <>
      <CartesianGrid vertical={false} />
      <XAxis
        tick={{ fill: "hsl(var(--muted-foreground))" }}
        dataKey="label"
        tickLine={false}
        axisLine={false}
      />
      <YAxis
        tick={{ fill: "hsl(var(--muted-foreground))" }}
        domain={[0, "auto"]}
        width={36}
        tickLine={false}
        axisLine={false}
      />
      <ChartTooltip content={<ChartTooltipContent />} />
      {Object.keys(config).map((key) =>
        line ? (
          <Line
            key={key}
            dataKey={key}
            type="linear"
            connectNulls={false}
            stroke={`var(--color-${key})`}
            strokeWidth={2}
            strokeDasharray={key === "planned" ? "5 4" : undefined}
            isAnimationActive={false}
          />
        ) : (
          <Bar
            key={key}
            dataKey={key}
            fill={`var(--color-${key})`}
            radius={[3, 3, 0, 0]}
            isAnimationActive={false}
          />
        )
      )}
    </>
  );
  return (
    <ChartContainer
      config={config}
      className={`${height} w-full aspect-auto [&_.recharts-surface]:focus-visible:outline [&_.recharts-surface]:focus-visible:outline-2`}
    >
      {line ? (
        <LineChart data={rows} accessibilityLayer>
          {children}
        </LineChart>
      ) : (
        <BarChart
          data={rows}
          accessibilityLayer
          barCategoryGap="12%"
          barGap={2}
        >
          {children}
        </BarChart>
      )}
    </ChartContainer>
  );
}
export function StreamVisualizationReview({
  direction,
}: {
  direction: number;
}) {
  const option = options[direction];
  const [paletteIndex, setPaletteIndex] = useState(0);
  const palette = palettes[paletteIndex];
  return (
    <div
      className="visualization-review space-y-3 w-full min-w-0 max-w-3xl"
      data-testid="stream-visualization-review"
      style={
        {
          "--review-series-1": palette.colors[0],
          "--review-series-2": palette.colors[1],
        } as CSSProperties
      }
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span
          className="rounded bg-primary/15 px-2 py-1"
          style={{ color: "var(--review-series-1)" }}
        >
          DESIGN REVIEW
        </span>
        <span>Synthetic data · not connected to telemetry</span>
      </div>
      <h2 className="text-lg font-semibold">
        {direction + 1}. {option.name}
      </h2>
      <p className="text-sm text-muted-foreground">{option.description}</p>
      <div className="space-y-2" aria-label="Theme chart palette comparison">
        <p className="text-xs text-muted-foreground">
          Graph palette · neon or selected-theme colors
        </p>
        <div className="flex flex-wrap gap-2">
          {palettes.map((item, index) => (
            <Button
              key={item.name}
              size="sm"
              variant={paletteIndex === index ? "primary" : "default"}
              aria-pressed={paletteIndex === index}
              onClick={() => setPaletteIndex(index)}
            >
              <span className="flex gap-1" aria-hidden="true">
                {item.colors.map((color) => (
                  <span
                    key={color}
                    className="size-2.5 rounded-full border border-foreground/20"
                    style={{ backgroundColor: color }}
                  />
                ))}
              </span>
              {item.name}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {palette.description}. Light themes use deeper saturated tones for
          contrast.
        </p>
      </div>
      <Card
        className="flex flex-wrap items-center justify-between gap-2 border-l-4 px-3 py-2"
        style={{ borderLeftColor: "var(--review-series-1)" }}
      >
        <div>
          <p className="text-xs text-muted-foreground">
            Friday delivery · items
          </p>
          <p className={`${option.metric} font-semibold tabular-nums`}>
            74{" "}
            <span className="text-xs font-normal text-muted-foreground">
              items
            </span>
          </p>
        </div>
        <p className="text-xs" style={{ color: "var(--review-series-1)" }}>
          +6 from Thursday
        </p>
      </Card>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {["Bar", "Line", "Area", "Scatter"].map((kind) => (
          <Card key={kind} className={`${option.padding} min-w-0 space-y-1.5`}>
            <h3 className="text-sm font-semibold">{kind} chart</h3>
            <p className="text-xs text-muted-foreground">
              {kind === "Scatter"
                ? "Planned vs observed · items on both axes"
                : "Daily delivery · items · 2–6 Nov 2026"}
            </p>
            {kind === "Bar" || kind === "Line" ? (
              <SampleChart line={kind === "Line"} height={option.height} />
            ) : (
              <ChartContainer
                config={config}
                className={`${option.height} w-full aspect-auto`}
              >
                {kind === "Area" ? (
                  <AreaChart data={rows} accessibilityLayer>
                    <CartesianGrid vertical={false} />
                    <XAxis
                      tick={{ fill: "hsl(var(--muted-foreground))" }}
                      dataKey="label"
                    />
                    <YAxis
                      tick={{ fill: "hsl(var(--muted-foreground))" }}
                      width={32}
                      domain={[0, "auto"]}
                    />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Area
                      dataKey="observed"
                      type="linear"
                      stroke="var(--color-observed)"
                      fill="var(--color-observed)"
                      fillOpacity={0.22}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                    <Area
                      dataKey="planned"
                      type="linear"
                      stroke="var(--color-planned)"
                      fill="var(--color-planned)"
                      fillOpacity={0.08}
                      strokeDasharray="5 4"
                      isAnimationActive={false}
                    />
                  </AreaChart>
                ) : (
                  <ScatterChart accessibilityLayer>
                    <CartesianGrid />
                    <XAxis
                      tick={{ fill: "hsl(var(--muted-foreground))" }}
                      type="number"
                      dataKey="planned"
                      name="Planned"
                      domain={[0, "auto"]}
                    />
                    <YAxis
                      tick={{ fill: "hsl(var(--muted-foreground))" }}
                      type="number"
                      dataKey="observed"
                      name="Observed"
                      width={32}
                      domain={[0, "auto"]}
                    />
                    <ZAxis range={[70, 70]} />
                    <ChartTooltip
                      cursor={{ strokeDasharray: "3 3" }}
                      content={<ChartTooltipContent />}
                    />
                    <Scatter
                      name="Observed"
                      data={rows.filter((r) => r.observed !== null)}
                      fill="var(--color-observed)"
                      isAnimationActive={false}
                    />
                  </ScatterChart>
                )}
              </ChartContainer>
            )}
            <div className="flex gap-4 text-xs">
              <span style={{ color: "var(--review-series-1)" }}>
                ● Observed
              </span>
              {kind !== "Scatter" && (
                <span style={{ color: "var(--review-series-2)" }}>
                  ┄ Planned
                </span>
              )}
            </div>
            <details>
              <summary className="cursor-pointer text-xs">
                View exact data · {kind}
              </summary>
              <table className="w-full mt-3 text-xs text-left">
                <caption className="sr-only">
                  Synthetic delivery in items. All five observations are
                  present.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Day</th>
                    <th scope="col">Observed</th>
                    <th scope="col">Planned</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.label} className="border-t">
                      <th scope="row" className="py-2">
                        {r.label}
                      </th>
                      <td>{r.observed ?? "Missing"}</td>
                      <td>{r.planned}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </Card>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Synthetic design review · 2–6 Nov 2026 · zero baseline · scatter:
        planned x, observed y, both in items. Schema and posting API pending
        selection.
      </p>
    </div>
  );
}
