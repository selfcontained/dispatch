import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Clock, X, Pause, Play, CalendarClock } from "lucide-react";
import type { ScheduledMessage } from "@dispatch/shared";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
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
import { Hint } from "@/components/ui/tooltip";

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
    const pending = mutation.isPending && mutation.variables?.id === s.id;
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
        <div className="flex items-start gap-2 bg-surface-subtle px-4 py-3">
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
        <div className="space-y-3 px-4 pb-3 pt-4">
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
        {isCurrentSchedule(s) && (
          <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-border-subtle bg-[hsl(var(--card))] px-4 py-2 sm:px-4">
            {s.status !== "uncertain" && (
              <Button
                size="sm"
                disabled={mutation.isPending}
                onClick={() =>
                  action(s, s.status === "paused" ? "resume" : "pause")
                }
              >
                {s.status === "paused" ? <Play /> : <Pause />}
                {pending && mutation.variables?.action !== "cancel"
                  ? s.status === "paused"
                    ? "Resuming…"
                    : "Pausing…"
                  : s.status === "paused"
                    ? "Resume"
                    : "Pause"}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              tone="danger"
              disabled={mutation.isPending}
              onClick={() => action(s, "cancel")}
            >
              {pending && mutation.variables?.action === "cancel"
                ? "Cancelling…"
                : "Cancel schedule"}
            </Button>
          </div>
        )}
        {feedback?.id === s.id && (
          <p
            role="status"
            className="px-4 pb-3 text-body-sm text-muted-foreground"
          >
            {feedback.text}
          </p>
        )}
        {mutation.error && mutation.variables?.id === s.id && (
          <p role="alert" className="px-4 pb-3 text-body-sm text-danger">
            {mutation.error.message}
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
        className="w-[calc(100vw-1.5rem)] sm:w-[min(660px,calc(100vw-3rem))] max-h-[90dvh] gap-0 p-0 text-foreground"
        onEscapeKeyDown={(event) => event.stopPropagation()}
        onCloseAutoFocus={(event) => {
          if (!scheduleId && fallbackFocus.current?.isConnected) {
            event.preventDefault();
            fallbackFocus.current.focus();
          }
        }}
      >
        <DialogClose asChild>
          <IconButton
            className="absolute right-2 top-2"
            label="Close scheduled messages"
          >
            <X />
          </IconButton>
        </DialogClose>
        <DialogHeader className="shrink-0 border-b border-border-subtle px-4 py-3 pr-14">
          <DialogTitle className="flex items-center gap-2 text-heading-md">
            <CalendarClock className="h-4 w-4 shrink-0 text-heading-accent-1" />
            Scheduled messages
          </DialogTitle>
          <DialogDescription>Times in {scheduleTimezone()}.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto">
          {query.isPending ? (
            <p className="p-6 text-body-md">Loading schedules…</p>
          ) : query.error ? (
            <div className="p-6">
              <p role="alert" className="text-body-md text-danger">
                {query.error.message}
              </p>
              <Button variant="ghost" onClick={() => void query.refetch()}>
                Try again
              </Button>
            </div>
          ) : (
            <div className="min-h-0">
              <div className="border-b border-border-subtle p-3">
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
                {scheduleId && !schedules.some((s) => s.id === scheduleId) && (
                  <p className="px-4 pt-4 text-body-md text-muted-foreground">
                    Schedule unavailable.
                  </p>
                )}
                {selected ? (
                  render(selected)
                ) : (
                  <div className="p-6 text-body-md text-muted-foreground">
                    The agent’s future reminders will appear here.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
