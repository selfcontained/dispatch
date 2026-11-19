import { useState } from "react";
import { RunnerCommand, useRunnerInstaller } from "./runner-onboarding";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Runner } from "@/hooks/use-runners";
import { isVersionNewer } from "@/lib/tips/version-compare";
import { formatRelativeTime } from "@/lib/format";

const reportDateTimeOptions: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "shortOffset",
};

const memory = (bytes: number) =>
  bytes < 1024 ** 3
    ? `${Math.round(bytes / 1024 ** 2)} MiB`
    : `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

export function RunnerHealthDetails({ runner }: { runner: Runner }) {
  const { health, healthReceivedAt } = runner;
  const [open, setOpen] = useState(false);
  const installer = useRunnerInstaller(open);
  const tag = installer.data?.tag;
  if (!health || !healthReceivedAt)
    return runner.status === "online" ? (
      <p className="mt-1 text-xs text-muted-foreground">
        No health report received.
      </p>
    ) : null;
  const update =
    tag &&
    /^v?\d+\.\d+\.\d+$/.test(health.version) &&
    isVersionNewer(tag, health.version);
  const stale =
    runner.status !== "online" ||
    Date.now() - Date.parse(healthReceivedAt) > 90_000;
  return (
    <details
      className="mt-1 text-xs text-muted-foreground"
      onToggle={(event) => setOpen(event.currentTarget.open)}
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
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <time
                  dateTime={healthReceivedAt}
                  tabIndex={0}
                  className="cursor-help rounded-sm underline decoration-dotted underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {formatRelativeTime(healthReceivedAt)}
                </time>
              </TooltipTrigger>
              <TooltipContent>
                {new Date(healthReceivedAt).toLocaleString(
                  undefined,
                  reportDateTimeOptions
                )}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </dd>
      </dl>
      {update && (
        <div className="mt-2 space-y-1">
          <p>
            Update available · {tag}. Run this on {runner.name} when its
            sessions are finished.
          </p>
          <RunnerCommand
            value={`sudo /opt/dispatch-runner/install-dispatch-runner.sh update --tag ${tag}`}
            label="Update"
          />
        </div>
      )}
    </details>
  );
}
