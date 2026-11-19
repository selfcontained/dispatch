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

function RunnerReportTime({ receivedAt }: { receivedAt: string }) {
  const [open, setOpen] = useState(false);
  const relativeTime = formatRelativeTime(receivedAt);

  return (
    <TooltipProvider>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger
          type="button"
          aria-label={`Last report: ${relativeTime}`}
          className="cursor-pointer rounded-sm underline decoration-dotted underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-6"
          onClick={(event) => {
            // Radix closes the tooltip on click by default. Let activation open it.
            event.preventDefault();
            setOpen(true);
          }}
        >
          <time dateTime={receivedAt}>{relativeTime}</time>
        </TooltipTrigger>
        <TooltipContent>
          {new Date(receivedAt).toLocaleString(
            undefined,
            reportDateTimeOptions
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

const memory = (bytes: number) =>
  bytes < 1024 ** 3
    ? `${Math.round(bytes / 1024 ** 2)} MiB`
    : `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

export function isRunnerHealthFresh(
  { status, healthReceivedAt }: Runner,
  now = Date.now()
) {
  return (
    status === "online" &&
    healthReceivedAt !== undefined &&
    now - Date.parse(healthReceivedAt) <= 90_000
  );
}

export function RunnerHealthDetails({ runner }: { runner: Runner }) {
  const { health, healthReceivedAt } = runner;
  const [open, setOpen] = useState(false);
  const installer = useRunnerInstaller(open);
  const tag = installer.data?.tag;
  if (!health || !healthReceivedAt)
    return (
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Health</h3>
        <p className="text-sm text-muted-foreground">
          No health report received.
        </p>
      </div>
    );
  const update =
    tag &&
    /^v?\d+\.\d+\.\d+$/.test(health.version) &&
    isVersionNewer(tag, health.version);
  const stale = !isRunnerHealthFresh(runner);
  return (
    <details
      className="text-sm text-muted-foreground"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      data-testid="runner-health"
    >
      <summary className="w-fit cursor-pointer rounded-sm py-1 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="font-medium">Health</span>
        <span className="ml-2 text-xs text-muted-foreground">
          {stale && "Last report · "}
          {health.sessions} {health.sessions === 1 ? "session" : "sessions"} ·{" "}
          {health.working} working
        </span>
      </summary>
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs [&>dd]:text-foreground">
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
          <RunnerReportTime receivedAt={healthReceivedAt} />
        </dd>
      </dl>
      {update && (
        <div className="mt-3 space-y-2 text-xs">
          <p className="font-medium text-foreground">
            Update available · {tag}
          </p>
          <p className="break-words">
            Run this on {runner.name} after its sessions finish.
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
