import {
  CircleGauge,
  Cpu,
  Database,
  HardDrive,
  MemoryStick,
  Users,
} from "lucide-react";

import { Panel } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { DashboardSection } from "@/components/ui/dashboard";
import type { ServiceResourcesResponse } from "@/hooks/use-service-resources";
import { ResourceChart } from "./service-resources-chart";
import {
  cpuChartConfig,
  hostMemoryChartConfig,
  memoryChartConfig,
} from "./service-resources-chart-config";
import {
  formatBytes,
  formatMs,
  formatUptime,
} from "./service-resources-format";
import { ServiceResourcesSubsystems } from "./service-resources-subsystems";

function SummaryCard({
  icon: Icon,
  label,
  value,
  detail,
  description,
  wrapDetail = false,
  scope,
}: {
  icon: typeof Cpu;
  label: string;
  value: string;
  detail: string;
  description?: string;
  wrapDetail?: boolean;
  scope: "Dispatch" | "Agents" | "Dependency" | "Host";
}) {
  return (
    <Panel
      data-testid={`resource-card-${label.toLowerCase().replaceAll(" ", "-")}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="text-muted-foreground">
          <Icon className="h-4 w-4" />
        </div>
        <span className="section-label">{scope}</span>
      </div>
      <div className="mt-3 text-body-sm text-muted-foreground">{label}</div>
      <div className="mt-1 break-words text-heading-lg text-foreground sm:text-display">
        {value}
      </div>
      <div
        className={`mt-1 text-body-sm text-muted-foreground ${wrapDetail ? "break-words" : "truncate"}`}
        title={wrapDetail ? undefined : detail}
      >
        {detail}
      </div>
      {description && (
        <p className="mt-1 break-words text-body-sm text-muted-foreground">
          {description}
        </p>
      )}
    </Panel>
  );
}

export function ServiceResourcesDashboard({
  data,
}: {
  data: ServiceResourcesResponse;
}) {
  const current = data.current;
  const chartData = data.series.map((sample) => ({
    at: sample.at,
    serverCpuPercent: sample.serverCpuPercent,
    agentCpuPercent: sample.agentCpuPercent,
    hostLoad1: sample.hostLoad1,
    hostTotalGiB:
      sample.hostTotalMemoryBytes == null
        ? null
        : sample.hostTotalMemoryBytes / 1024 ** 3,
    hostFreeGiB:
      sample.hostFreeMemoryBytes == null
        ? null
        : sample.hostFreeMemoryBytes / 1024 ** 3,
    serverRssMb: sample.serverRssBytes / 1024 / 1024,
    serverHeapMb: sample.serverHeapBytes / 1024 / 1024,
    agentRssMb:
      sample.agentRssBytes === null ? null : sample.agentRssBytes / 1024 / 1024,
  }));
  const workloadItems = [
    {
      label: "Active sessions (including children)",
      value: current.workloads.runningAgents,
    },
    { label: "Connected browsers", value: current.workloads.sseClients },
    { label: "Scheduled jobs", value: current.workloads.scheduledJobs },
    {
      label: "Git refreshes active",
      value: current.workloads.gitRefreshesInFlight,
      wide: true,
    },
  ];

  return (
    <>
      {data.overall.reasons.length > 0 && (
        <Alert tone="warning" title="Dispatch needs attention">
          {data.overall.reasons.map((reason) => (
            <p key={reason.code}>{reason.message}</p>
          ))}
        </Alert>
      )}

      <section className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-3">
        <SummaryCard
          icon={Cpu}
          label="Dispatch CPU"
          value={`${current.server.cpuPercent.toFixed(1)}%`}
          detail="One-core percentage"
          scope="Dispatch"
        />
        <SummaryCard
          icon={MemoryStick}
          label="Dispatch memory"
          value={formatBytes(current.server.rssBytes)}
          detail={`${formatBytes(current.server.heapUsedBytes)} JS heap`}
          scope="Dispatch"
        />
        <SummaryCard
          icon={Users}
          label="Agent process memory"
          value={
            current.agents.rssBytes === null
              ? "Unavailable"
              : current.agents.processCount === 0
                ? "None"
                : formatBytes(current.agents.rssBytes)
          }
          detail={
            current.agents.cpuPercent === null
              ? "Process-tree sampling unavailable"
              : current.agents.processCount === 0
                ? "No agent processes running"
                : `${current.agents.cpuPercent.toFixed(1)}% CPU`
          }
          wrapDetail
          description={
            current.agents.cpuPercent !== null &&
            current.agents.processCount !== 0
              ? `${current.agents.processCount ?? 0} OS processes, including descendants. CPU is the ps average.`
              : undefined
          }
          scope="Agents"
        />
        <SummaryCard
          icon={Database}
          label="Database"
          value={formatMs(current.database.latencyMs)}
          detail={`${formatBytes(current.database.sizeBytes)} on disk`}
          scope="Dependency"
        />
        <SummaryCard
          icon={CircleGauge}
          label="Event-loop p95"
          value={formatMs(current.eventLoop.p95DelayMs)}
          detail={`${formatMs(current.http.p95DurationMs)} API p95`}
          scope="Dispatch"
        />
        <SummaryCard
          icon={HardDrive}
          label="Host memory free"
          value={formatBytes(current.host.freeMemoryBytes)}
          detail={`${current.host.load1.toFixed(2)} load / ${current.host.cpuCount} CPUs`}
          scope="Host"
        />
      </section>

      <section className="grid gap-8 lg:grid-cols-2 lg:gap-4">
        <ResourceChart
          title="CPU history"
          description="CPU uses one-core percentages (can exceed 100%). Dispatch is interval usage; agents use the OS ps average. Host load uses the right axis."
          data={chartData}
          config={cpuChartConfig}
          keys={["serverCpuPercent", "agentCpuPercent"]}
          secondaryKey="hostLoad1"
          unit="%"
        />
        <ResourceChart
          title="Process memory history"
          description="Resident memory and JavaScript heap over the selected window."
          data={chartData}
          config={memoryChartConfig}
          keys={["serverRssMb", "serverHeapMb", "agentRssMb"]}
          unit=" MB"
        />
      </section>

      <section
        aria-label="System memory history"
        data-testid="host-memory-history"
      >
        <ResourceChart
          title="System memory history"
          description={`${formatBytes(current.host.freeMemoryBytes)} free of ${formatBytes(current.host.totalMemoryBytes)} total${current.host.totalMemoryBytes > 0 ? ` (${((current.host.freeMemoryBytes / current.host.totalMemoryBytes) * 100).toFixed(1)}% left)` : ""}. Includes all apps, browsers, and dev servers on this host. OS-reported free RAM is not a memory-pressure or swap metric.`}
          data={chartData}
          config={hostMemoryChartConfig}
          keys={["hostTotalGiB", "hostFreeGiB"]}
          unit=" GiB"
          primaryAxisWidth={64}
        />
      </section>

      <ServiceResourcesSubsystems
        subsystems={data.subsystems}
        series={data.series}
      />

      <section className="grid gap-8 md:grid-cols-2 md:gap-4">
        <DashboardSection title="Workload">
          <Panel className="grid grid-cols-2 gap-4 text-body-md">
            {workloadItems.map((item) => (
              <div
                key={item.label}
                className={item.wide ? "col-span-2" : undefined}
              >
                <div className="text-body-sm text-muted-foreground">
                  {item.label}
                </div>
                <div className="mt-1 text-heading-lg">{item.value}</div>
              </div>
            ))}
          </Panel>
        </DashboardSection>
        <DashboardSection title="Capacity">
          <Panel className="space-y-3 text-body-md">
            <div className="flex items-center justify-between gap-3 border-b border-border-subtle pb-3">
              <span className="text-muted-foreground">Service uptime</span>
              <span className="font-medium">
                {formatUptime(current.server.uptimeSeconds)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-border-subtle pb-3">
              <span className="text-muted-foreground">Database pool</span>
              <span className="font-medium">
                {current.database.pool.total - current.database.pool.idle}/
                {current.database.pool.max} active ·{" "}
                {current.database.pool.total} open
              </span>
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-border-subtle pb-3">
              <span className="text-muted-foreground">Database on disk</span>
              <span className="font-medium">
                {formatBytes(current.database.sizeBytes)}
              </span>
            </div>
            <div
              className="border-b border-border pb-3"
              data-testid="artifact-storage"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">
                  Retained artifacts on disk
                </span>
                <span className="font-medium">
                  {formatBytes(current.artifacts?.sizeBytes ?? null)}
                </span>
              </div>
              <p className="mt-1 text-body-sm text-muted-foreground">
                Shared files and agent journals/logs across all sessions,
                including archived sessions. Excludes database, worktrees, and
                provider caches. Refreshes every 5 minutes.
                {current.artifacts?.error
                  ? " Latest scan failed; any displayed size is from the last successful scan."
                  : current.artifacts?.sampledAt
                    ? ` Last scanned ${new Date(current.artifacts.sampledAt).toLocaleTimeString()}.`
                    : " Waiting for a scan."}
              </p>
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-border-subtle pb-3">
              <span className="text-muted-foreground">Requests (1 min)</span>
              <span className="font-medium">
                {current.http.requestsPerMinute}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Host CPUs</span>
              <span className="font-medium">{current.host.cpuCount}</span>
            </div>
          </Panel>
        </DashboardSection>
      </section>
    </>
  );
}
