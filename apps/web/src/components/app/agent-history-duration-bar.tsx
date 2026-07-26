import { Bar, BarChart, XAxis, YAxis } from "recharts";

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatDuration } from "@/lib/format";

const durationChartConfig: ChartConfig = {
  working: { label: "Working", color: "hsl(var(--status-working))" },
  blocked: { label: "Blocked", color: "hsl(var(--status-blocked))" },
  waiting_user: { label: "Waiting", color: "hsl(var(--status-waiting))" },
};

export function DurationBar({
  durations,
}: {
  durations: Record<string, number>;
}) {
  const total = Object.values(durations).reduce((a, b) => a + b, 0);
  if (total === 0) return null;

  const data = [
    {
      name: "Duration",
      working: durations.working ?? 0,
      blocked: durations.blocked ?? 0,
      waiting_user: durations.waiting_user ?? 0,
    },
  ];

  return (
    <ChartContainer config={durationChartConfig} className="h-8 w-full">
      <BarChart data={data} layout="vertical" barSize={24}>
        <XAxis type="number" hide />
        <YAxis type="category" dataKey="name" hide />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value) => formatDuration(Number(value))}
            />
          }
        />
        <Bar
          dataKey="working"
          stackId="a"
          fill="var(--color-working)"
          radius={[4, 0, 0, 4]}
        />
        <Bar dataKey="blocked" stackId="a" fill="var(--color-blocked)" />
        <Bar
          dataKey="waiting_user"
          stackId="a"
          fill="var(--color-waiting_user)"
          radius={[0, 4, 4, 0]}
        />
      </BarChart>
    </ChartContainer>
  );
}
