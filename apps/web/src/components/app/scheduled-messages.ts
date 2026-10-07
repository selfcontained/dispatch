import { useQuery } from "@tanstack/react-query";
import {
  scheduledMessageCadence,
  type ScheduledMessage,
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
export function scheduleTime(value: string) {
  const date = new Date(value);
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() !== new Date().getFullYear() ? { year: "numeric" as const } : {}) })} at ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
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
