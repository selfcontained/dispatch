import { Clock } from "lucide-react";
import type { ScheduledMessagePresentation } from "@dispatch/shared";
import { ScheduledMessagesButton } from "../scheduled-messages-button";
import {
  cadence,
  isCurrentSchedule,
  scheduleStatusLabels,
  scheduleTime,
  useScheduledMessages,
} from "../scheduled-messages";
import { Markdown } from "@/components/ui/markdown";

export function ScheduledMessageEntry({
  agentId,
  scheduleId,
  delivery,
  fallbackText,
  presentation,
  deliveryStatus,
}: {
  agentId: string;
  scheduleId: string;
  delivery: boolean;
  fallbackText: string;
  presentation?: ScheduledMessagePresentation;
  deliveryStatus?: string;
}) {
  const query = useScheduledMessages(agentId);
  const cached = query.data?.find((s) => s.id === scheduleId);
  const schedule = delivery
    ? (cached ?? presentation)
    : (presentation ?? cached);
  const current = schedule ? isCurrentSchedule(schedule) : true;
  return (
    <div
      data-testid="scheduled-message-entry"
      className={`min-w-0 overflow-hidden rounded-lg border px-3 py-2 ${current || delivery ? "border-border bg-muted/20" : "border-border/70 bg-muted/20"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <span
          className={`flex items-center gap-1.5 font-medium ${current || delivery ? "text-heading-accent-1" : "text-muted-foreground"}`}
        >
          <span className="flex h-5 w-5 items-center justify-center rounded-lg bg-transparent">
            <Clock className="h-3 w-3" />
          </span>
          {delivery ? "Scheduled delivery" : "Scheduled reminder"}
        </span>
        {!delivery && schedule && (
          <span className="text-muted-foreground">
            {scheduleStatusLabels[schedule.status]}
          </span>
        )}
      </div>
      <div className="space-y-1.5 pt-1.5">
        {schedule ? (
          <>
            <h3 className="text-xs font-medium text-muted-foreground tracking-tight [overflow-wrap:anywhere]">
              {schedule.title}
            </h3>
            {delivery ? (
              <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
                {presentation?.message ?? schedule.message}
              </p>
            ) : (
              <p className="line-clamp-2 whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">
                {schedule.message}
              </p>
            )}
          </>
        ) : (
          <Markdown>{fallbackText}</Markdown>
        )}
      </div>
      {delivery && deliveryStatus && (
        <p className="mt-1 text-xs text-muted-foreground">
          {deliveryStatus === "accepted"
            ? "Accepted by agent"
            : deliveryStatus === "discarded"
              ? "Discarded by schedule"
              : deliveryStatus === "uncertain"
                ? "Acceptance unconfirmed · schedule suspended"
                : "Waiting for agent"}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-3 -mb-2">
        {!delivery && schedule && (
          <div className="text-xs text-muted-foreground space-y-1">
            <p>
              {cadence(schedule)}
              {schedule.status === "active"
                ? ` · Next ${scheduleTime(schedule.nextDueAt)}`
                : ""}
            </p>
            <p>
              {schedule.deliveredCount} of {schedule.maxDeliveries} accepted ·
              Ends{" "}
              <time
                dateTime={schedule.expiresAt}
                title={new Date(schedule.expiresAt).toLocaleString()}
              >
                {scheduleTime(schedule.expiresAt)}
              </time>
            </p>
          </div>
        )}
        <ScheduledMessagesButton
          agentId={agentId}
          scheduleId={scheduleId}
          ended={!current}
        />
      </div>
    </div>
  );
}
