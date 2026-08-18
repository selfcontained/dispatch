import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  AlertOctagon,
  CheckCircle2,
  CircleDashed,
  HelpCircle,
  Radio,
  RotateCw,
  Unplug,
} from "lucide-react";

import { latestEventLabel } from "@/components/app/agent-event-utils";
import { type Agent } from "@/components/app/types";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { usePeerName } from "@/hooks/use-peers";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Mirrors the endpoint's default cap, so the pane can say when it truncated. */
const EVENT_LIMIT = 200;

type EventType = NonNullable<Agent["latestEvent"]>["type"];

type AgentEvent = {
  id: number;
  type: EventType;
  message: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
};

/**
 * Per-type presentation. `blocked` and `waiting_user` are what a person scans
 * a timeline for, so they get a filled marker and a tinted rail; `working` is
 * the overwhelming majority of entries and stays deliberately quiet.
 */
const EVENT_STYLES: Record<
  EventType,
  {
    icon: typeof AlertOctagon;
    dot: string;
    text: string;
    row: string;
    loud: boolean;
  }
> = {
  blocked: {
    icon: AlertOctagon,
    dot: "border-status-blocked bg-status-blocked/20 text-status-blocked",
    text: "text-status-blocked",
    row: "border-status-blocked/35 bg-status-blocked/[0.07]",
    loud: true,
  },
  waiting_user: {
    icon: HelpCircle,
    dot: "border-status-waiting bg-status-waiting/20 text-status-waiting",
    text: "text-status-waiting",
    row: "border-status-waiting/35 bg-status-waiting/[0.07]",
    loud: true,
  },
  done: {
    icon: CheckCircle2,
    dot: "border-status-done bg-status-done/20 text-status-done",
    text: "text-status-done",
    row: "border-transparent",
    loud: false,
  },
  working: {
    icon: CircleDashed,
    dot: "border-status-working/60 bg-status-working/10 text-status-working",
    text: "text-status-working",
    row: "border-transparent",
    loud: false,
  },
  idle: {
    icon: CircleDashed,
    dot: "border-border bg-muted text-muted-foreground",
    text: "text-muted-foreground",
    row: "border-transparent",
    loud: false,
  },
};

/**
 * The system marker `markPeerUnreachable` stamps on a shadow when the link
 * drops. Rendered as a visible break rather than an ordinary entry — the gap it
 * announces is the honest part.
 */
function isLinkBreak(event: AgentEvent): boolean {
  return event.metadata?.peerUnreachable === true;
}

function LinkBreakRow({
  event,
  peerName,
}: {
  event: AgentEvent;
  peerName: string | null;
}): JSX.Element {
  return (
    <li className="flex items-center gap-3 py-3 text-xs">
      <span className="h-px flex-1 border-t border-dashed border-status-waiting/40" />
      <span className="flex shrink-0 items-center gap-1.5 text-status-waiting">
        <Unplug className="h-3.5 w-3.5" aria-hidden="true" />
        Lost contact with {peerName ?? "the linked instance"} ·{" "}
        <time
          dateTime={event.createdAt}
          title={formatDateTime(event.createdAt)}
        >
          {formatRelativeTime(event.createdAt)}
        </time>
      </span>
      <span className="h-px flex-1 border-t border-dashed border-status-waiting/40" />
    </li>
  );
}

function EventRow({
  event,
  isLast,
}: {
  event: AgentEvent;
  isLast: boolean;
}): JSX.Element {
  const style = EVENT_STYLES[event.type] ?? EVENT_STYLES.idle;
  const Icon = style.icon;

  return (
    <li className="flex gap-3">
      {/* Rail: marker plus the connector to the next entry. */}
      <div className="flex w-5 shrink-0 flex-col items-center">
        <span
          className={cn(
            "mt-1.5 grid h-5 w-5 place-items-center rounded-full border",
            style.dot
          )}
        >
          <Icon className="h-3 w-3" aria-hidden="true" />
        </span>
        {/* No connector past the final marker — it would dangle into nothing. */}
        {isLast ? null : <span className="w-px flex-1 bg-border/60" />}
      </div>

      <div
        className={cn(
          "mb-2 min-w-0 flex-1 rounded-md border px-2.5 py-1.5",
          style.row
        )}
      >
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              "shrink-0 text-xs",
              style.text,
              style.loud && "font-semibold"
            )}
          >
            {latestEventLabel(event.type)}
          </span>
          {/* Relative time is the only stamp in the pane; keep the exact
              value reachable on hover and to assistive tech. */}
          <time
            dateTime={event.createdAt}
            title={formatDateTime(event.createdAt)}
            className="shrink-0 font-mono text-[10px] text-muted-foreground/60"
          >
            {formatRelativeTime(event.createdAt)}
          </time>
        </div>
        <p className="mt-0.5 break-words text-sm leading-relaxed text-foreground/90">
          {event.message}
        </p>
      </div>
    </li>
  );
}

/**
 * What a shadow agent opens to instead of a terminal. Its tmux pane lives on
 * another machine, but its events are already structured data — type, message,
 * timestamp — so a timeline says more than a relayed terminal would, and says
 * it without granting anyone a shell on the other box.
 */
export function RemoteActivityPane({ agent }: { agent: Agent }): JSX.Element {
  const peerName = usePeerName(agent.peerId);
  // Keyed on the latest event's timestamp so an arriving SSE upsert refetches
  // the history — the live feed only ever carries the newest event, never the
  // entries that preceded it.
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["agent-events", agent.id, agent.latestEvent?.updatedAt ?? null],
    queryFn: async () =>
      (
        await api<{ events: AgentEvent[] }>(
          `/api/v1/agents/${agent.id}/events?limit=${EVENT_LIMIT}`
        )
      ).events,
    staleTime: 5_000,
    // The key changes on every arriving event, so without this the list
    // unmounts to a loading line and the scroll position resets each time —
    // continuous blinking on a chatty remote agent.
    placeholderData: keepPreviousData,
    // One cache entry per event timestamp would otherwise accumulate for the
    // lifetime of the tab.
    gcTime: 30_000,
  });

  const events = data ?? [];
  const stale = agent.latestEvent?.metadata?.peerUnreachable === true;

  return (
    <div
      data-testid="remote-activity-pane"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <Badge className="border-status-working/40 bg-status-working/10 text-status-working">
          <Radio className="mr-1 h-3 w-3" />
          {peerName ?? "Linked instance"}
        </Badge>
        <span className="min-w-0 truncate text-sm font-medium">
          {agent.name}
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          {stale ? (
            <>
              <Unplug className="h-3.5 w-3.5 text-status-waiting" />
              Link down — last known state
            </>
          ) : agent.status === "running" || agent.status === "creating" ? (
            <>
              {/* Decorative here — the adjacent text carries the state, and
                  ActivityBars hardcodes role="status" aria-label="Loading". */}
              <span aria-hidden="true" className="flex items-center">
                <ActivityBars size={12} />
              </span>
              Mirroring live
            </>
          ) : (
            "Not running"
          )}
        </span>
        {/* The rail reads like a downward chronological log; it isn't. */}
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
          Newest first
        </span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-4 py-4">
          {isError ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
              <Unplug className="h-8 w-8 text-status-blocked" />
              <p className="text-sm text-foreground">
                Couldn't load activity from this instance.
              </p>
              <p className="max-w-sm text-xs">
                This is a local problem reading the mirrored history — it says
                nothing about whether the remote agent is working.
              </p>
              <Button
                variant="default"
                size="sm"
                className="mt-1"
                onClick={() => void refetch()}
              >
                <RotateCw className="mr-1.5 h-3.5 w-3.5" />
                Try again
              </Button>
            </div>
          ) : isLoading ? (
            <p className="text-sm text-muted-foreground">Loading activity…</p>
          ) : events.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
              <Radio className="h-8 w-8" />
              <p className="text-sm">
                Nothing reported yet from {peerName ?? "the linked instance"}.
              </p>
              <p className="max-w-sm text-xs">
                This agent's terminal runs on another machine. Its status events
                appear here as it reports them.
              </p>
            </div>
          ) : (
            <ol data-testid="remote-activity-timeline">
              {events.map((event) =>
                isLinkBreak(event) ? (
                  <LinkBreakRow
                    key={event.id}
                    event={event}
                    peerName={peerName}
                  />
                ) : (
                  <EventRow
                    key={event.id}
                    event={event}
                    // The truncation row continues the rail, so the last event
                    // is only "last" when nothing follows it.
                    isLast={
                      events.length < EVENT_LIMIT &&
                      event.id === events[events.length - 1].id
                    }
                  />
                )
              )}
              {/* A full page means older entries fell off the end. Distinct
                  from a link drop, which the footer's caveat covers. */}
              {events.length >= EVENT_LIMIT ? (
                <li className="flex items-center gap-3 py-3 text-xs text-muted-foreground/70">
                  <span className="h-px flex-1 border-t border-dashed border-border" />
                  <span className="shrink-0">
                    Showing the last {EVENT_LIMIT} events
                  </span>
                  <span className="h-px flex-1 border-t border-dashed border-border" />
                </li>
              ) : null}
            </ol>
          )}
        </div>
      </ScrollArea>

      {/* Status is state, not content, in this design: nothing is replayed
          after a drop. Saying so beats implying a complete log. */}
      <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground/70">
        Mirrored from {peerName ?? "the linked instance"} — status events only,
        best effort. Entries can be missing where the link was down.
      </p>
    </div>
  );
}
