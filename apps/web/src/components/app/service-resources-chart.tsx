import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { ChartFrame, DashboardSection } from "@/components/ui/dashboard";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

export function ResourceChart({
  title,
  description,
  data,
  config,
  keys,
  unit,
  secondaryKey,
  primaryAxisWidth = 60,
}: {
  title: string;
  description: string;
  data: Array<Record<string, number | null>>;
  config: ChartConfig;
  keys: string[];
  unit: string;
  secondaryKey?: string;
  primaryAxisWidth?: number;
}) {
  const allKeys = secondaryKey ? [...keys, secondaryKey] : keys;
  return (
    <DashboardSection
      title={title}
      description={description}
      // Descriptions differ in length; frames side by side still line up.
      className="flex h-full flex-col gap-3 space-y-0 [&>[data-chart-frame]]:mt-auto"
    >
      <ChartFrame>
        {data.length < 2 ? (
          <div className="flex h-full items-center justify-center text-body-md text-muted-foreground">
            Collecting history…
          </div>
        ) : (
          <ChartContainer
            config={config}
            className="aspect-auto min-h-0 w-full flex-1"
          >
            <AreaChart
              data={data}
              margin={{
                left: 0,
                right: secondaryKey ? 0 : 8,
                top: 8,
                bottom: 0,
              }}
            >
              <defs>
                {allKeys.map((key) => (
                  <linearGradient
                    key={key}
                    id={`resource-${key}`}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop
                      offset="5%"
                      stopColor={`var(--color-${key})`}
                      stopOpacity={0.28}
                    />
                    <stop
                      offset="95%"
                      stopColor={`var(--color-${key})`}
                      stopOpacity={0.02}
                    />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="at"
                tickLine={false}
                axisLine={false}
                minTickGap={28}
                tickFormatter={(value) =>
                  new Date(Number(value)).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })
                }
              />
              <YAxis
                yAxisId="primary"
                width={primaryAxisWidth}
                tickLine={false}
                axisLine={false}
                tickFormatter={(value) => `${Math.round(Number(value))}${unit}`}
              />
              {secondaryKey && (
                <YAxis
                  yAxisId="secondary"
                  orientation="right"
                  width={36}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value) => Number(value).toFixed(1)}
                />
              )}
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    indicator="line"
                    formatter={(value, name, item) => [
                      item.dataKey === secondaryKey
                        ? `${Number(value).toFixed(2)} load`
                        : `${Number(value).toFixed(1)}${unit}`,
                      config[String(item.dataKey)]?.label ?? name,
                    ]}
                  />
                }
                labelFormatter={(value) =>
                  new Date(Number(value)).toLocaleTimeString()
                }
              />
              <ChartLegend content={<ChartLegendContent />} />
              {allKeys.map((key) => (
                <Area
                  key={key}
                  yAxisId={key === secondaryKey ? "secondary" : "primary"}
                  type="monotone"
                  dataKey={key}
                  stroke={`var(--color-${key})`}
                  fill={`url(#resource-${key})`}
                  strokeWidth={2}
                  connectNulls
                />
              ))}
            </AreaChart>
          </ChartContainer>
        )}
      </ChartFrame>
    </DashboardSection>
  );
}
