import { Fragment, useState } from "react";

import {
  EVENT_TYPE_COLORS,
  EVENT_TYPE_LABELS,
} from "@/components/app/agent-history-event-types";
import { cn } from "@/lib/utils";
import { type HistoryEvent } from "@/hooks/use-agent-history";

// ── Event timeline ──────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function EventTimeline({ events }: { events: HistoryEvent[] }) {
  const [expanded, setExpanded] = useState(false);
  const showAll = expanded || events.length <= 10;
  const visible = showAll
    ? events
    : [...events.slice(0, 5), ...events.slice(-5)];
  const hiddenCount = events.length - 10;

  return (
    <div className="relative">
      <div className="space-y-0">
        {visible.map((event, i) => {
          const isGap = !showAll && i === 5;
          return (
            <Fragment key={event.id}>
              {isGap && (
                <button
                  onClick={() => setExpanded(true)}
                  className="ml-[7px] flex items-center gap-2 py-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  <span className="h-px w-3 bg-border" />
                  {hiddenCount} more event{hiddenCount !== 1 ? "s" : ""}
                </button>
              )}
              <div className="group flex items-start gap-3 py-1">
                <div className="flex flex-col items-center pt-1.5">
                  <div
                    className={cn(
                      "h-2 w-2 shrink-0 rounded-full",
                      EVENT_TYPE_COLORS[event.event_type] ??
                        "bg-muted-foreground"
                    )}
                  />
                  {i < visible.length - 1 && (
                    <div className="mt-0.5 w-px flex-1 bg-border" />
                  )}
                </div>
                <div className="min-w-0 flex-1 pb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">
                      {formatTimestamp(event.created_at)}
                    </span>
                    <span
                      className={cn(
                        "inline-block rounded px-1 py-0.5 text-[10px] font-medium",
                        event.event_type === "working" &&
                          "bg-status-working/15 text-status-working",
                        event.event_type === "blocked" &&
                          "bg-status-blocked/15 text-status-blocked",
                        event.event_type === "waiting_user" &&
                          "bg-status-waiting/15 text-status-waiting",
                        event.event_type === "done" &&
                          "bg-status-done/15 text-status-done",
                        event.event_type === "idle" &&
                          "bg-muted text-muted-foreground"
                      )}
                    >
                      {EVENT_TYPE_LABELS[event.event_type] ?? event.event_type}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-foreground">
                    {event.message}
                  </p>
                </div>
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
