import { Fragment, useCallback, useMemo, useState } from "react";
import { CheckCircle2, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Markdown } from "@/components/ui/markdown";
import {
  EVENT_TYPE_COLORS,
  EVENT_TYPE_LABELS,
} from "@/components/app/agent-history-event-types";
import { cn } from "@/lib/utils";
import {
  type HistoryEvent,
  type HistoryFeedbackItem,
} from "@/hooks/use-agent-history";

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

// ── Feedback constants ──────────────────────────────────────────────

const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-red-500",
  high: "bg-orange-500",
  medium: "bg-yellow-500",
  low: "bg-blue-400",
  info: "bg-muted-foreground",
};

const SEVERITY_LABELS: Record<
  string,
  { label: string; variant: "error" | "default" }
> = {
  critical: { label: "Critical", variant: "error" },
  high: { label: "High", variant: "error" },
  medium: { label: "Medium", variant: "default" },
  low: { label: "Low", variant: "default" },
  info: { label: "Info", variant: "default" },
};

const FEEDBACK_STATUS_LABELS: Record<string, { label: string; color: string }> =
  {
    fixed: { label: "Fixed", color: "text-green-500" },
    ignored: { label: "Ignored", color: "text-muted-foreground/60" },
    dismissed: { label: "Dismissed", color: "text-muted-foreground/60" },
  };

const PERSONA_COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
];

// ── Feedback timeline ───────────────────────────────────────────────

function FeedbackItemRow({
  item,
  isExpanded,
  onToggle,
}: {
  item: HistoryFeedbackItem;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const dotColor = SEVERITY_DOT[item.severity] ?? SEVERITY_DOT.info;
  const statusLabel = FEEDBACK_STATUS_LABELS[item.status];
  const isResolved =
    item.status === "fixed" ||
    item.status === "ignored" ||
    item.status === "dismissed";
  const severityInfo = SEVERITY_LABELS[item.severity] ?? SEVERITY_LABELS.info;

  return (
    <div className={cn("min-w-0", isResolved && "opacity-50")}>
      <button
        className="flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-1.5 text-left text-[11px] hover:bg-muted/40 transition-colors"
        onClick={onToggle}
      >
        <ChevronRight
          className={cn(
            "h-2.5 w-2.5 shrink-0 text-muted-foreground/60 transition-transform",
            isExpanded && "rotate-90"
          )}
        />
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotColor)} />
        <span className="shrink-0 font-mono text-muted-foreground truncate max-w-[100px] sm:max-w-[120px]">
          {item.filePath
            ? `${item.filePath.split("/").pop()}${item.lineNumber ? `:${item.lineNumber}` : ""}`
            : "—"}
        </span>
        <span className="min-w-0 flex-1 truncate text-foreground">
          {item.description}
        </span>
        {statusLabel ? (
          <span className={cn("shrink-0 text-[9px]", statusLabel.color)}>
            {item.status === "fixed" && (
              <CheckCircle2 className="mr-0.5 inline h-2.5 w-2.5" />
            )}
            {statusLabel.label}
          </span>
        ) : null}
      </button>

      {isExpanded ? (
        <div className="ml-4 mr-1 mb-2 overflow-hidden rounded-md border border-border bg-background px-3 py-2.5 text-xs shadow-sm space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant={severityInfo.variant}>{severityInfo.label}</Badge>
            {item.filePath ? (
              <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                {item.filePath}
                {item.lineNumber ? `:${item.lineNumber}` : ""}
              </span>
            ) : null}
            {statusLabel ? (
              <span className={cn("ml-auto text-[11px]", statusLabel.color)}>
                {statusLabel.label}
              </span>
            ) : null}
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">
              Description
            </div>
            <Markdown className="text-sm text-foreground">
              {item.description}
            </Markdown>
          </div>

          {item.suggestion ? (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1">
                Suggestion
              </div>
              <Markdown className="text-sm text-muted-foreground">
                {item.suggestion}
              </Markdown>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function FeedbackTimeline({
  feedback,
}: {
  feedback: HistoryFeedbackItem[];
}) {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set()
  );

  const groups = useMemo(() => {
    const map = new Map<string, HistoryFeedbackItem[]>();
    for (const item of feedback) {
      const key = item.persona ?? "__unknown__";
      const list = map.get(key);
      if (list) list.push(item);
      else map.set(key, [item]);
    }
    return map;
  }, [feedback]);

  const needsGrouping = groups.size > 1;
  const personaSlugs = useMemo(() => Array.from(groups.keys()), [groups]);

  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return (
    <div className="min-w-0 space-y-2">
      {Array.from(groups.entries()).map(([persona, items]) => {
        const colorIdx = personaSlugs.indexOf(persona);
        const color = PERSONA_COLORS[colorIdx % PERSONA_COLORS.length];
        const isCollapsed = needsGrouping && collapsedGroups.has(persona);
        const label = persona === "__unknown__" ? "Unknown" : persona;

        return (
          <div key={persona}>
            {needsGrouping ? (
              <button
                className="flex w-full items-center gap-1.5 mb-0.5 py-0.5 text-left hover:bg-muted/40 rounded transition-colors"
                onClick={() => toggleGroup(persona)}
              >
                <ChevronRight
                  className={cn(
                    "h-2.5 w-2.5 shrink-0 text-muted-foreground/60 transition-transform",
                    !isCollapsed && "rotate-90"
                  )}
                />
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: color }}
                />
                <span className="text-xs font-medium" style={{ color }}>
                  {label}
                </span>
                <span className="text-[10px] text-muted-foreground/50">
                  {items.length}
                </span>
              </button>
            ) : null}
            {!isCollapsed ? (
              <div className={cn("space-y-px", needsGrouping && "ml-2.5")}>
                {items.map((item) => (
                  <FeedbackItemRow
                    key={item.id}
                    item={item}
                    isExpanded={expandedId === item.id}
                    onToggle={() =>
                      setExpandedId(expandedId === item.id ? null : item.id)
                    }
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
