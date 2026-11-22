import cronstrue from "cronstrue";
import { CheckCircle2, XCircle } from "lucide-react";

import { ActivityBars } from "@/components/ui/activity-bars";
import { type JobRun, type JobRunStatus } from "@/hooks/use-jobs";
import { formatDateTime } from "@/lib/format";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { type StatusDotTone } from "@/components/ui/status-dot";
import { statusLabel } from "@/lib/status-label";

export const ACTIVE_RUN_STATUSES: JobRunStatus[] = [
  "started",
  "running",
  "needs_input",
];

export function statusTone(status: JobRunStatus | null): BadgeTone {
  if (status === "completed") return "info";
  if (status === "failed" || status === "timed_out" || status === "crashed")
    return "danger";
  if (status === "needs_input") return "warning";
  if (status === "started" || status === "running") return "success";
  return "neutral";
}

export function statusIcon(status: JobRunStatus | null): JSX.Element | null {
  if (status === "completed") return <CheckCircle2 />;
  if (status === "failed" || status === "timed_out" || status === "crashed")
    return <XCircle />;
  if (status === "started" || status === "running" || status === "needs_input")
    return <ActivityBars size={12} className="shrink-0" />;
  return null;
}

export function statusTextColor(status: JobRunStatus | null): string {
  if (status === "completed") return "text-status-done";
  if (status === "failed" || status === "timed_out" || status === "crashed")
    return "text-status-blocked";
  if (status === "needs_input") return "text-status-waiting";
  if (status === "started" || status === "running")
    return "text-status-working";
  return "text-muted-foreground";
}

export function statusDotTone(status: JobRunStatus | null): StatusDotTone {
  if (status === "completed") return "done";
  if (status === "failed" || status === "timed_out" || status === "crashed")
    return "blocked";
  if (status === "needs_input") return "waiting";
  if (status === "started" || status === "running") return "working";
  return "neutral";
}

/** A job's last run, drawn the same in the list and on the job. */
export function JobStatusBadge({
  status,
  empty = "Never run",
  className,
}: {
  status: JobRunStatus | null;
  empty?: string;
  className?: string;
}): JSX.Element {
  return (
    <Badge tone={statusTone(status)} className={className}>
      {statusIcon(status)}
      {status ? statusLabel(status) : empty}
    </Badge>
  );
}

export function formatJobDateTime(iso: string | null | undefined): string {
  if (!iso) return "Not scheduled";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return formatDateTime(iso);
}

export function minutesFromMs(ms: number | null | undefined): string {
  if (!ms) return "";
  return String(Math.max(1, Math.round(ms / 60_000)));
}

export function msFromMinutes(value: string): number | undefined {
  const minutes = Number.parseInt(value, 10);
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined;
  return minutes * 60_000;
}

export function cronError(
  schedule: string,
  enabled: boolean,
  continuationEnabled = false
): string | null {
  const trimmed = schedule.trim();
  if (!trimmed)
    return enabled && !continuationEnabled
      ? "Add a cron schedule or turn on the loop before enabling this job."
      : null;
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5)
    return "Use a 5-field cron expression like */30 * * * *.";
  return null;
}

export function humanSchedule(schedule: string | null): string {
  if (!schedule) return "On demand";
  try {
    return cronstrue.toString(schedule, { use24HourTimeFormat: false });
  } catch {
    return `Cron: ${schedule.trim()}`;
  }
}

export function triggerSourceLabel(run: JobRun): string {
  if (run.config.triggerSource === "scheduled") return "Scheduled";
  if (run.config.triggerSource === "webhook") return "Webhook";
  return "Manual";
}
