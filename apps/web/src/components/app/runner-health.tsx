import { useState } from "react";
import { RunnerCommand, useRunnerInstaller } from "./runner-onboarding";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Runner } from "@/hooks/use-runners";
import { formatRelativeTime } from "@/lib/format";
import { isVersionNewer } from "@/lib/tips/version-compare";

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

const maintenanceSteps = {
  prepare: "preparing the update",
  stage: "downloading or verifying the release",
  stop: "stopping the idle service",
  signal: "signaling the runner’s main process",
  replace: "replacing the runner binary",
  start: "starting the updated service",
  restore: "restoring the previous service",
  unit: "refreshing the systemd service",
};

/** Revisions may be reported at different abbreviation lengths. */
export function sameRevision(a: string, b: string) {
  const [short, long] = [a.toLowerCase(), b.toLowerCase()].sort(
    (x, y) => x.length - y.length
  );
  return short!.length >= 7 && long!.startsWith(short!);
}

export function RunnerHealthDetails({ runner }: { runner: Runner }) {
  const { health, healthReceivedAt } = runner;
  const [open, setOpen] = useState(false);
  const installer = useRunnerInstaller(open);
  const target = installer.data;
  if (!health || !healthReceivedAt)
    return (
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Health</h3>
        <p className="text-sm text-muted-foreground">
          No health report received.
        </p>
      </div>
    );
  const reportedVersion = health.version.replace(/^v/, "");
  const sameBuild =
    target?.version === reportedVersion &&
    target.revision &&
    health.revision &&
    sameRevision(health.revision, target.revision);
  const comparable = target && /^\d+\.\d+\.\d+$/.test(reportedVersion);
  const ahead = comparable && isVersionNewer(reportedVersion, target.version);
  const updateAvailable =
    comparable &&
    (isVersionNewer(target.version, reportedVersion) ||
      (target.version === reportedVersion &&
        target.revision &&
        health.revision &&
        !sameBuild));
  const buildStatus = sameBuild
    ? "Up to date"
    : updateAvailable
      ? "Update available"
      : ahead
        ? "Runner is newer"
        : "Unknown";
  const failure = health.maintenanceFailure;
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
          {failure &&
            (failure.exitCode === 75
              ? " · Update deferred"
              : " · Update failed")}
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
        <dd>
          {health.version}
          {health.revision && (
            <span className="ml-2 break-all font-mono">{health.revision}</span>
          )}
        </dd>
        {target && (
          <>
            <dt>Wanted build</dt>
            <dd>
              {target.version}
              {target.revision && (
                <span className="ml-2 break-all font-mono">
                  {target.revision}
                </span>
              )}
            </dd>
            <dt>Build status</dt>
            <dd>{buildStatus}</dd>
          </>
        )}
        {failure && (
          <>
            <dt>Last update attempt</dt>
            <dd>
              {failure.exitCode === 75
                ? "Deferred while an agent was working"
                : `Failed while ${maintenanceSteps[failure.step]}`}{" "}
              (exit {failure.exitCode}) ·{" "}
              <RunnerReportTime receivedAt={failure.at} />
            </dd>
          </>
        )}
        <dt>Last report</dt>
        <dd>
          <RunnerReportTime receivedAt={healthReceivedAt} />
        </dd>
      </dl>
      {failure && failure.exitCode !== 75 && (
        <div className="mt-2 text-xs">
          <p>Read the updater’s error output on {runner.name}.</p>
          <RunnerCommand
            value="sudo cat /opt/dispatch-runner/last-maintenance.log"
            label="Update log"
          />
        </div>
      )}
      {updateAvailable && target.command && (
        <div className="mt-3 text-xs">
          <RunnerCommand value={target.command} label="Update" />
        </div>
      )}
    </details>
  );
}
