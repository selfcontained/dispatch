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

const rows = [
  { label: "Mon", observed: 42, planned: 40 },
  { label: "Tue", observed: 56, planned: 50 },
  { label: "Wed", observed: 61, planned: 60 },
  { label: "Thu", observed: 68, planned: 65 },
  { label: "Fri", observed: 74, planned: 70 },
];
const config = {
  observed: { label: "Observed", color: "hsl(var(--chart-1))" },
  planned: { label: "Planned", color: "hsl(var(--chart-2))" },
};
const options = [
  {
    name: "Compact inline",
    description:
      "Quiet, dense blocks that sit naturally between messages. Best for frequent updates.",
    padding: "p-4",
    height: "h-40",
    metric: "text-3xl",
  },
  {
    name: "Analytical panel",
    description:
      "More room for axes, comparison and exact values. Best for explaining a result.",
    padding: "p-6",
    height: "h-56",
    metric: "text-4xl",
  },
  {
    name: "Presentation card",
    description:
      "A strong headline and generous space. Best for occasional milestones and handoffs.",
    padding: "p-8",
    height: "h-64",
    metric: "text-5xl",
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
  return (
    <div
      className="space-y-4 w-full min-w-0 max-w-3xl"
      data-testid="stream-visualization-review"
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span
          className="rounded bg-primary/15 px-2 py-1"
          style={{ color: "hsl(var(--chart-1))" }}
        >
          DESIGN REVIEW
        </span>
        <span>Synthetic data · not connected to telemetry</span>
      </div>
      <h2 className="text-lg font-semibold">
        {direction + 1}. {option.name}
      </h2>
      <p className="text-sm text-muted-foreground">{option.description}</p>
      <Card
        className={`${option.padding} border-l-4 border-l-[hsl(var(--chart-1))]`}
      >
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Metric · Friday delivery
        </p>
        <p className={`${option.metric} font-semibold mt-2`}>
          74 <span className="text-sm text-muted-foreground">items</span>
        </p>
        <p className="text-sm mt-2" style={{ color: "hsl(var(--chart-1))" }}>
          +6 items from Thursday
        </p>
      </Card>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {["Bar", "Line", "Area", "Scatter"].map((kind) => (
          <Card key={kind} className={`${option.padding} min-w-0 space-y-3`}>
            <h3 className="font-semibold">{kind} chart</h3>
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
              <span style={{ color: "hsl(var(--chart-1))" }}>● Observed</span>
              {kind !== "Scatter" && (
                <span style={{ color: "hsl(var(--chart-2))" }}>┄ Planned</span>
              )}
            </div>
            <details>
              <summary className="cursor-pointer text-xs">
                View exact data · {kind}
              </summary>
              <table className="w-full mt-3 text-xs text-left">
                <caption className="sr-only">
                  Synthetic delivery in items. Missing Wednesday observation.
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
            <p className="text-xs text-muted-foreground">
              {kind === "Scatter"
                ? "Each point is one day · units: items."
                : "Complete synthetic sample · zero baseline."}
            </p>
          </Card>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Review fixture inside the real stream message renderer. Schema and
        posting API are still pending selection.
      </p>
    </div>
  );
}
