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
    return "border-status-done/45 bg-status-done/15 text-status-done";
  if (status === "failed" || status === "timed_out" || status === "crashed")
    return "border-status-blocked/45 bg-status-blocked/15 text-status-blocked";
  if (status === "needs_input")
    return "border-status-waiting/45 bg-status-waiting/15 text-status-waiting";
  if (status === "started" || status === "running")
    return "border-status-working/45 bg-status-working/15 text-status-working";
  return "border-border bg-muted/35 text-muted-foreground";
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

export function formatDate(iso: string | null | undefined): string {
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function cronError(schedule: string, enabled: boolean): string | null {
  const trimmed = schedule.trim();
  if (!trimmed)
    return enabled ? "Add a cron schedule before enabling this job." : null;
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5)
    return "Use a 5-field cron expression like */30 * * * *.";
  return null;
}

export function shortPath(value: string): string {
  const parts = value.split("/").filter(Boolean);
  if (parts.length <= 3) return value;
  return `.../${parts.slice(-3).join("/")}`;
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

export function formatTimeUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms) || ms < 0) return "now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "< 1m";
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24)
    return remMins > 0 ? `in ${hours}h ${remMins}m` : `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

export function formatTimeUntilDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (isToday) return `Today at ${time}`;
  if (isTomorrow) return `Tomorrow at ${time}`;
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
