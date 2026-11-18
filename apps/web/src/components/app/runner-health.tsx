import type { Runner } from "@/hooks/use-runners";
import { formatRelativeTime } from "@/lib/format";

const memory = (bytes: number) =>
  bytes < 1024 ** 3
    ? `${Math.round(bytes / 1024 ** 2)} MiB`
    : `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

export function RunnerHealthDetails({ runner }: { runner: Runner }) {
  const { health, healthReceivedAt } = runner;
  if (!health || !healthReceivedAt) return null;
  const stale =
    runner.status !== "online" ||
    Date.now() - Date.parse(healthReceivedAt) > 90_000;
  return (
    <details
      className="mt-1 text-xs text-muted-foreground"
      data-testid="runner-health"
    >
      <summary className="w-fit cursor-pointer rounded py-1 text-foreground focus-visible:ring-2">
        {stale && "Last report · "}
        {health.sessions} {health.sessions === 1 ? "session" : "sessions"} ·{" "}
        {health.working} working
      </summary>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt>CPU</dt>
        <dd>
          {health.cpuPercent === null ? "Sampling…" : `${health.cpuPercent}%`}
        </dd>
        <dt>Memory</dt>
        <dd>
          {memory(health.memoryUsed)} of {memory(health.memoryTotal)}
        </dd>
        <dt>Runner version</dt>
        <dd>{health.version}</dd>
        <dt>Last report</dt>
        <dd>
          <time dateTime={healthReceivedAt}>
            {formatRelativeTime(healthReceivedAt)}
          </time>
        </dd>
      </dl>
    </details>
  );
}
