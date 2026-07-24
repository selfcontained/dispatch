import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
}: {
  title: string;
  description: string;
  data: Array<Record<string, number | null>>;
  config: ChartConfig;
  keys: string[];
  unit: string;
  secondaryKey?: string;
}) {
  const allKeys = secondaryKey ? [...keys, secondaryKey] : keys;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
        <CardDescription className="text-xs">{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {data.length < 2 ? (
          <div className="flex h-44 items-center justify-center text-sm text-muted-foreground">
            Collecting history…
          </div>
        ) : (
          <ChartContainer config={config} className="h-52 w-full aspect-auto">
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
                width={40}
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
              <ChartLegend
                content={
                  <ChartLegendContent className="flex-wrap gap-x-4 gap-y-1" />
                }
              />
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
      </CardContent>
    </Card>
  );
}
