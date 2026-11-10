import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
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
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import "../index.css";

const rows = [
  { label: "Mon", observed: 42, planned: 40 },
  { label: "Tue", observed: 56, planned: 50 },
  { label: "Wed", observed: null, planned: 60 },
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
      <XAxis dataKey="label" tickLine={false} axisLine={false} />
      <YAxis
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
        <BarChart data={rows} accessibilityLayer>
          {children}
        </BarChart>
      )}
    </ChartContainer>
  );
}
function Options() {
  const [dark, setDark] = useState(false);
  return (
    <div className={dark ? "dark" : ""}>
      <main
        className="min-h-screen bg-background text-foreground p-4 md:p-10 overflow-auto"
        style={{ height: "100dvh" }}
      >
        <div className="mx-auto max-w-6xl space-y-6">
          <header className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-widest text-muted-foreground">
                Dispatch · Design checkpoint
              </p>
              <h1 className="text-2xl font-semibold mt-2">
                Data, in the conversation
              </h1>
              <p className="text-sm text-muted-foreground mt-2">
                Three directions · identical synthetic data · no telemetry
                collected
              </p>
            </div>
            <Button variant="default" onClick={() => setDark(!dark)}>
              {dark ? "Light theme" : "Dark theme"}
            </Button>
          </header>
          <div className="grid gap-6 lg:grid-cols-3">
            {options.map((option, i) => (
              <section key={option.name} className="min-w-0 space-y-4">
                <div>
                  <h2 className="font-semibold">
                    {i + 1}. {option.name}
                  </h2>
                  <p className="text-sm text-muted-foreground mt-1">
                    {option.description}
                  </p>
                </div>
                <Card
                  className={`${option.padding} space-y-3 ${i === 2 ? "border-t-4 border-t-primary" : ""}`}
                >
                  <p className="text-sm text-muted-foreground">
                    Items delivered · Friday
                  </p>
                  <p className={`${option.metric} font-semibold tabular-nums`}>
                    74{" "}
                    <span className="text-sm font-normal text-muted-foreground">
                      items
                    </span>
                  </p>
                  <p className="text-sm">+6 items compared with Thursday</p>
                  <p className="text-xs text-muted-foreground">
                    Synthetic · as of 6 Nov 2026
                  </p>
                </Card>
                {[false, true].map((line) => (
                  <Card
                    key={String(line)}
                    className={`${option.padding} space-y-3`}
                  >
                    <div>
                      <h3 className="font-medium">
                        {line ? "Delivery over time" : "Daily delivery"}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        Items · 2–6 Nov 2026
                      </p>
                    </div>
                    <SampleChart line={line} height={option.height} />
                    <div className="flex gap-4 text-xs">
                      <span>● Observed</span>
                      <span>┄ Planned</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Synthetic example · Wednesday observation missing
                    </p>
                    <details>
                      <summary className="cursor-pointer text-sm">
                        View exact data
                      </summary>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs mt-3 text-left">
                          <caption className="sr-only">
                            Daily delivery in items, synthetic
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
                      </div>
                    </details>
                  </Card>
                ))}
              </section>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">
            Review prototype only. All directions retain explicit units, zero
            baseline, gaps for missing observations and exact data. Final stream
            API and persistence are not connected yet.
          </p>
        </div>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Options />);
