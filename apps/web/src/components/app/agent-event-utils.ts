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
