import {
  AgentIdLabel,
  CopyButton,
  DeleteButton,
  RelativeTime,
} from "@/components/app/brain-card-shared";
import { KeyValueTable } from "@/components/app/brain-key-value-table";
import type { BrainEvent } from "@/hooks/use-brain";
import { cn } from "@/lib/utils";

// ── Kind styles ────────────────────────────────────────────────

const KIND_STYLES: Record<
  string,
  { dot: string; text: string; badge: string }
> = {
  decision: {
    dot: "bg-chart-4",
    text: "text-chart-4",
    badge: "bg-chart-4/tint-strong text-chart-4",
  },
  assessment: {
    dot: "bg-chart-2",
    text: "text-chart-2",
    badge: "bg-chart-2/tint-strong text-chart-2",
  },
  observation: {
    dot: "bg-chart-3",
    text: "text-chart-3",
    badge: "bg-chart-3/tint-strong text-chart-3",
  },
};

function getKindStyle(kind: string) {
  return (
    KIND_STYLES[kind] ?? {
      dot: "bg-muted-foreground",
      text: "text-muted-foreground",
      badge: "bg-muted text-muted-foreground",
    }
  );
}

export function EventCard({
  event,
  agentId,
  onDelete,
}: {
  event: BrainEvent;
  agentId?: string;
  onDelete?: () => void;
}): JSX.Element {
  const style = getKindStyle(event.kind);

  const meta: Record<string, unknown> = {};
  meta.collection = event.collection;
  if (event.subject) meta.subject = event.subject;
  if (event.tags.length > 0) meta.tags = event.tags;
  meta.createdAt = event.createdAt;

  const payload =
    event.value != null &&
    typeof event.value === "object" &&
    !Array.isArray(event.value)
      ? (event.value as Record<string, unknown>)
      : event.value != null
        ? { value: event.value }
        : {};

  const allEntries = { ...(payload as Record<string, unknown>), ...meta };

  return (
    <div className="mx-3 mb-2 rounded-md border border-border bg-surface-subtle p-2.5 overflow-hidden">
      <div className="flex items-center justify-between gap-2 mb-2 min-w-0">
        <div className="flex items-center gap-1.5 text-body-sm min-w-0">
          <span className={cn("h-2 w-2 rounded-full shrink-0", style.dot)} />
          <span
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-label-xs shrink-0",
              style.badge
            )}
          >
            {event.kind}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-label-xs text-muted-foreground shrink-0">
          {agentId ? <AgentIdLabel agentId={agentId} /> : null}
          <CopyButton value={event.value} />
          {onDelete ? (
            <DeleteButton
              label={`Delete event ${event.kind}`}
              onClick={onDelete}
            />
          ) : null}
          <RelativeTime iso={event.createdAt} />
        </div>
      </div>
      <div className="rounded bg-surface-subtle px-2.5 py-2 overflow-x-auto">
        <KeyValueTable value={allEntries} />
      </div>
    </div>
  );
}
