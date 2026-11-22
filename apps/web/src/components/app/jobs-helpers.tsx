import cronstrue from "cronstrue";
import { CheckCircle2, XCircle } from "lucide-react";

import { ActivityBars } from "@/components/ui/activity-bars";
import { type JobRun, type JobRunStatus } from "@/hooks/use-jobs";
import { formatDateTime } from "@/lib/format";

export const ACTIVE_RUN_STATUSES: JobRunStatus[] = [
  "started",
  "running",
  "needs_input",
];

export function statusClasses(status: JobRunStatus | null): string {
  if (status === "completed")
    return "border-status-done/line bg-status-done/tint text-status-done";
  if (status === "failed" || status === "timed_out" || status === "crashed")
    return "border-status-blocked/line bg-status-blocked/tint text-status-blocked";
  if (status === "needs_input")
    return "border-status-waiting/line bg-status-waiting/tint text-status-waiting";
  if (status === "started" || status === "running")
    return "border-status-working/line bg-status-working/tint text-status-working";
  return "border-border bg-surface-subtle text-muted-foreground";
}

export function statusIcon(status: JobRunStatus | null): JSX.Element | null {
  if (status === "completed") return <CheckCircle2 className="h-3.5 w-3.5" />;
  if (status === "failed" || status === "timed_out" || status === "crashed")
    return <XCircle className="h-3.5 w-3.5" />;
  if (status === "started" || status === "running" || status === "needs_input")
    return <ActivityBars size={14} className="shrink-0" />;
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

export function statusDotColor(status: JobRunStatus | null): string {
  if (status === "completed") return "bg-status-done";
  if (status === "failed" || status === "timed_out" || status === "crashed")
    return "bg-status-blocked";
  if (status === "needs_input") return "bg-status-waiting";
  if (status === "started" || status === "running") return "bg-status-working";
  return "bg-muted-foreground";
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
