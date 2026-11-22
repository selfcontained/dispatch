import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Clock, Pause, Play, CalendarClock } from "lucide-react";
import type { ScheduledMessage } from "@dispatch/shared";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogBody,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Hint } from "@/components/ui/tooltip";
import {
  upcomingSchedulesKey,
  cadence,
  isCurrentSchedule,
  scheduledMessagesKey,
  scheduleStatusLabels,
  scheduleTime,
  scheduleTimezone,
  useScheduledMessages,
} from "./scheduled-messages";
import { Alert } from "@/components/ui/alert";
import { AsyncBoundary } from "@/components/ui/async-boundary";
import { EmptyState } from "@/components/ui/empty-state";

type Action = "pause" | "resume" | "cancel";
export function ScheduledMessagesButton({
  agentId,
  scheduleId,
  ended = false,
}: {
  agentId: string | null;
  scheduleId?: string;
  ended?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(
    scheduleId ?? null
  );
  const [feedback, setFeedback] = useState<{ id: string; text: string } | null>(
    null
  );
  const fallbackFocus = useRef<HTMLElement | null>(null);
  const client = useQueryClient();
  const queryKey = scheduledMessagesKey(agentId);
  const query = useScheduledMessages(
    agentId,
    open ? 2000 : scheduleId ? false : 15000
  );
  const schedules = query.data ?? [];
  const current = schedules.filter(isCurrentSchedule);
  const history = schedules.filter((s) => !isCurrentSchedule(s));
  const selected =
    schedules.find((s) => s.id === selectedId) ?? current[0] ?? history[0];
  const mutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: Action }) =>
      api<ScheduledMessage>(
        `/api/v1/agents/${encodeURIComponent(agentId!)}/scheduled-messages/${id}`,
        { method: "POST", body: JSON.stringify({ action }) }
      ),
    onSuccess: async (s, input) => {
      setSelectedId(s.id);
      setFeedback({
        id: s.id,
        text: `${input.action === "resume" ? "Schedule resumed." : input.action === "cancel" ? "Future deliveries cancelled." : "Schedule paused."}${input.action !== "resume" && s.outstanding && s.outstanding.phase !== "pending" ? " A message already accepted by the agent may still be read." : ""}`,
      });
      client.setQueryData<ScheduledMessage[]>(queryKey, (old) =>
        old?.map((item) => (item.id === s.id ? s : item))
      );
      await Promise.all([
        client.invalidateQueries({ queryKey }),
        client.invalidateQueries({ queryKey: upcomingSchedulesKey }),
      ]);
    },
  });
  if (!agentId) return null;
  const action = (s: ScheduledMessage, value: Action) => {
    setFeedback(null);
    mutation.mutate({ id: s.id, action: value });
  };
  const render = (s: ScheduledMessage) => {
    const status =
      s.status === "active"
        ? `Next ${scheduleTime(s.nextDueAt)}`
        : s.status === "paused"
          ? "No future deliveries while paused"
          : s.status === "uncertain"
            ? "Scheduling is suspended to avoid duplicates"
            : s.status === "cancelled"
              ? "No future deliveries"
              : s.status === "expired"
                ? "Delivery deadline passed"
                : s.status === "limit_reached"
                  ? "Accepted-message limit reached"
                  : "This reminder is complete";
    return (
      <section
        key={s.id}
        data-testid={`schedule-${s.id}`}
        className="flex min-w-0 flex-col"
      >
        <h3 className="sr-only">{s.title}</h3>
        <div className="flex items-start gap-2 rounded-md bg-surface-subtle px-3 py-3">
          <Clock className="mt-0.5 h-4 w-4 shrink-0 text-heading-accent-1" />
          <div className="min-w-0">
            <p className="text-body-md font-medium">
              {s.status === "active"
                ? `Next ${scheduleTime(s.nextDueAt)}`
                : `${scheduleStatusLabels[s.status]} · ${cadence(s)}`}
            </p>
            <p className="mt-0.5 text-body-sm text-muted-foreground">
              {s.status === "active" ? cadence(s) : status}
            </p>
            {s.outstanding && (
              <p className="mt-1 text-body-sm text-muted-foreground">
                {s.outstanding.phase === "accepted"
                  ? "Accepted · waiting for pickup"
                  : s.outstanding.phase === "submitting"
                    ? "Sending to agent"
                    : "Waiting to deliver"}
                {s.outstanding.ticks > 1
                  ? ` · ${s.outstanding.ticks} intervals combined`
                  : ""}
              </p>
            )}
          </div>
        </div>
        <div className="space-y-3 pb-3 pt-4">
          <p className="whitespace-pre-wrap text-body-md leading-relaxed [overflow-wrap:anywhere]">
            {s.message}
          </p>
          {s.stopWhen && (
            <p className="text-body-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
              <span className="font-medium">Stop when: </span>
              {s.stopWhen}
            </p>
          )}
          <p className="text-body-sm leading-relaxed text-muted-foreground">
            {s.deliveredCount} of {s.maxDeliveries} accepted · Ends{" "}
            <time dateTime={s.expiresAt}>{scheduleTime(s.expiresAt)}</time>
          </p>
          {s.error && <p className="text-body-sm text-warning">{s.error}</p>}
        </div>
        {feedback?.id === s.id && (
          <p role="status" className="pb-3 text-body-sm text-muted-foreground">
            {feedback.text}
          </p>
        )}
      </section>
    );
  };
  const stateLabel = ["active", "paused", "uncertain"]
    .map((status) => {
      const count = current.filter((s) => s.status === status).length;
      return count
        ? `${count} ${status === "uncertain" ? "needing attention" : status}`
        : null;
    })
    .filter(Boolean)
    .join(", ");
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) {
          setSelectedId(scheduleId ?? null);
          setFeedback(null);
          mutation.reset();
        }
      }}
    >
      {(scheduleId || current.length > 0) && (
        <DialogTrigger asChild>
          {scheduleId ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-body-sm text-primary hover:text-primary"
              onClick={(event) => {
                fallbackFocus.current = event.currentTarget;
              }}
            >
              {ended ? "View schedule" : "Manage schedule"}
            </Button>
          ) : (
            <Hint label={`Scheduled messages, ${stateLabel}`}>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-heading-accent-1 hover:bg-muted"
                aria-label={`Scheduled messages, ${stateLabel}`}
                data-testid="scheduled-messages-trigger"
                onClick={(event) => {
                  fallbackFocus.current =
                    event.currentTarget.parentElement?.querySelector<HTMLElement>(
                      '[data-testid="chat-filters-trigger"]'
                    ) ?? null;
                }}
              >
                <Clock className="text-heading-accent-1" />
                {current.length > 1 && (
                  <span className="text-body-sm font-medium tabular-nums">
                    {current.length}
                  </span>
                )}
              </Button>
            </Hint>
          )}
        </DialogTrigger>
      )}
      <DialogContent
        busy={mutation.isPending}
        className="text-foreground"
        onEscapeKeyDown={(event) => event.stopPropagation()}
        onCloseAutoFocus={(event) => {
          if (!scheduleId && fallbackFocus.current?.isConnected) {
            event.preventDefault();
            fallbackFocus.current.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 shrink-0 text-heading-accent-1" />
            Scheduled messages
          </DialogTitle>
          <DialogDescription>Times in {scheduleTimezone()}.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <AsyncBoundary query={query} thing="schedules">
            {() => (
              <div className="min-h-0">
                <div className="pb-3">
                  <Select
                    value={selected?.id ?? ""}
                    onValueChange={setSelectedId}
                  >
                    <SelectTrigger
                      aria-label="Choose scheduled message"
                      className="min-h-11 w-full min-w-0 text-body-sm"
                    >
                      <SelectValue placeholder="Choose scheduled message" />
                    </SelectTrigger>
                    <SelectContent className="max-w-[calc(100vw-2.5rem)]">
                      {[...current, ...history].map((s) => (
                        <SelectItem
                          key={s.id}
                          value={s.id}
                          className="min-h-11 text-body-sm"
                        >
                          {s.title}
                          {s.status !== "active"
                            ? ` · ${scheduleStatusLabels[s.status]}`
                            : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {current.length === 0 && (
                    <p className="mt-2 text-body-sm text-muted-foreground">
                      No current schedules.
                    </p>
                  )}
                </div>

                <div className="min-w-0">
                  {scheduleId &&
                    !schedules.some((s) => s.id === scheduleId) && (
                      <p className="pt-4 text-body-md text-muted-foreground">
                        Schedule unavailable.
                      </p>
                    )}
                  {selected ? (
                    render(selected)
                  ) : (
                    <EmptyState
                      icon={Clock}
                      title="No scheduled messages"
                      description="The agent’s future reminders will appear here."
                    />
                  )}
                </div>
              </div>
            )}
          </AsyncBoundary>
        </DialogBody>
        {selected &&
        mutation.error &&
        mutation.variables?.id === selected.id ? (
          <Alert
            title={`Couldn’t ${mutation.variables.action} the schedule.`}
            error={mutation.error}
          />
        ) : null}
        {selected && isCurrentSchedule(selected) ? (
          <DialogFooter
            start={
              <Button
                variant="ghost"
                tone="danger"
                disabled={mutation.isPending}
                pending={
                  mutation.isPending && mutation.variables?.action === "cancel"
                }
                onClick={() => action(selected, "cancel")}
              >
                Cancel schedule
              </Button>
            }
          >
            <DialogCancel>Done</DialogCancel>
            {selected.status !== "uncertain" && (
              <Button
                variant="primary"
                disabled={mutation.isPending}
                pending={
                  mutation.isPending && mutation.variables?.action !== "cancel"
                }
                onClick={() =>
                  action(
                    selected,
                    selected.status === "paused" ? "resume" : "pause"
                  )
                }
              >
                {selected.status === "paused" ? <Play /> : <Pause />}
                {selected.status === "paused" ? "Resume" : "Pause"}
              </Button>
            )}
          </DialogFooter>
        ) : (
          <DialogFooter>
            <DialogCancel>Done</DialogCancel>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
