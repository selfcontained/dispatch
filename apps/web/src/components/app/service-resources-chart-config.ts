import type { ChartConfig } from "@/components/ui/chart";

export const cpuChartConfig = {
  serverCpuPercent: { label: "Dispatch CPU", color: "hsl(var(--chart-1))" },
  agentCpuPercent: { label: "Agent CPU", color: "hsl(var(--chart-3))" },
  hostLoad1: { label: "Host load (1m)", color: "hsl(var(--chart-2))" },
} satisfies ChartConfig;

export const memoryChartConfig = {
  serverRssMb: { label: "Dispatch RSS", color: "hsl(var(--chart-1))" },
  serverHeapMb: { label: "JS heap", color: "hsl(var(--chart-4))" },
  agentRssMb: { label: "Agent RSS", color: "hsl(var(--chart-3))" },
} satisfies ChartConfig;

export const hostMemoryChartConfig = {
  hostTotalGiB: { label: "Total RAM", color: "hsl(var(--chart-2))" },
  hostFreeGiB: { label: "Free RAM", color: "hsl(var(--chart-3))" },
} satisfies ChartConfig;
