import type { Agent } from "@/components/app/types";

type EventType = NonNullable<Agent["latestEvent"]>["type"];

export function latestEventLabel(type: EventType): string {
  if (type === "waiting_user") return "Waiting";
  if (type === "working") return "Working";
  if (type === "blocked") return "Blocked";
  if (type === "done") return "Done";
  return "Idle";
}

export function latestEventColor(type: EventType): string {
  if (type === "working") return "text-status-working";
  if (type === "blocked") return "text-status-blocked";
  if (type === "waiting_user") return "text-status-waiting";
  if (type === "done") return "text-status-done";
  return "text-foreground/80";
}

export type ReviewVerdict = "approve" | "request_changes";

export function reviewVerdictLabel(verdict: ReviewVerdict): string {
  if (verdict === "approve") return "Approved";
  return "Changes Requested";
}

export function formatRelativeTime(value: string): string {
  const date = new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time)) return "";

  const deltaSeconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (deltaSeconds < 60) return "just now";
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m ago`;
  if (deltaSeconds < 86_400) return `${Math.floor(deltaSeconds / 3600)}h ago`;
  return `${Math.floor(deltaSeconds / 86_400)}d ago`;
}
