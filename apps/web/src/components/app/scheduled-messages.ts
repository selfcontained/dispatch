import { useQuery } from "@tanstack/react-query";
import {
  scheduledMessageCadence,
  type ScheduledMessage,
  type ScheduledMessageSummary,
} from "@dispatch/shared";
import { api } from "@/lib/api";

export const scheduledMessagesKey = (agentId: string | null) => [
  "scheduled-messages",
  agentId,
];
export const isCurrentSchedule = (s: Pick<ScheduledMessage, "status">) =>
  ["active", "paused", "uncertain"].includes(s.status);
export const scheduleStatusLabels: Record<ScheduledMessage["status"], string> =
  {
    active: "Active",
    paused: "Paused",
    completed: "Completed",
    cancelled: "Cancelled",
    expired: "Expired",
    limit_reached: "Limit reached",
    uncertain: "Needs attention",
  };
export function scheduleTime(value: string, now = new Date()) {
  const date = new Date(value);
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" as const } : {}) })} at ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}
/** Compact sidebar wording; schedule dialogs keep their full date and time. */
export function sidebarScheduleTime(value: string, today = new Date()) {
  const date = new Date(value);
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : scheduleTime(value, today);
}
export const scheduleTimezone = () =>
  new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value ?? "your local timezone";
export const cadence = (s: Pick<ScheduledMessage, "intervalSeconds">) =>
  scheduledMessageCadence(s.intervalSeconds);
export function useScheduledMessages(
  agentId: string | null,
  poll: false | number = false
) {
  return useQuery({
    queryKey: scheduledMessagesKey(agentId),
    queryFn: () =>
      api<ScheduledMessage[]>(
        `/api/v1/agents/${encodeURIComponent(agentId!)}/scheduled-messages`
      ),
    enabled: !!agentId,
    refetchInterval: poll,
    staleTime: 1000,
  });
}

export const upcomingSchedulesKey = ["scheduled-messages-upcoming"] as const;

/** All rows share a single request. Schedule stream entries invalidate it. */
export function useUpcomingSchedule(agentId: string) {
  return useQuery({
    queryKey: upcomingSchedulesKey,
    queryFn: () =>
      api<ScheduledMessageSummary>("/api/v1/scheduled-messages/upcoming"),
    staleTime: Infinity,
    select: (summary) => summary[agentId],
  }).data;
}
