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

/**
 * The row's own current-status label/color — "Stopped"/"Error" when the
 * agent isn't actively running, otherwise the latest event's own
 * label/color. `isStopped` is a caller-supplied condition (rather than
 * derived here from `agent.status`) so it can key off whatever "stopped"
 * means in context — e.g. ChildAgentRow's `state === "stopped"`, which
 * covers more than a literal `status === "stopped"`.
 *
 * This exists because the event's own label/color describes the latest
 * EVENT, not the agent's current status — a stopped or errored agent can
 * still have a stale "Working" event, which would otherwise render in the
 * active-work color even though the agent isn't running anymore.
 */
export function describeAgentStatus(
  agent: Pick<Agent, "status" | "latestEvent">,
  isStopped: boolean
): { label: string; colorClass: string } {
  const label =
    agent.status === "error"
      ? "Error"
      : isStopped
        ? "Stopped"
        : agent.latestEvent
          ? latestEventLabel(agent.latestEvent.type)
          : "Running";
  const colorClass =
    agent.status === "error"
      ? "text-status-blocked"
      : agent.latestEvent && !isStopped
        ? latestEventColor(agent.latestEvent.type)
        : "text-muted-foreground";
  return { label, colorClass };
}
