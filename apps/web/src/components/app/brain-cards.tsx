import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  History,
  Trash2,
} from "lucide-react";

import {
  useBrainListItems,
  type BrainObject,
  type BrainList,
  type BrainEvent,
} from "@/hooks/use-brain";
import { useCopyText } from "@/hooks/use-copy";
import { cn } from "@/lib/utils";

// ── Shared primitives ──────────────────────────────────────────

function formatRelative(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${diffDay}d ago`;
}

function RelativeTime({ iso }: { iso: string }): JSX.Element {
  const date = new Date(iso);
  return (
    <time
      dateTime={iso}
      title={date.toLocaleString()}
      className="text-muted-foreground whitespace-nowrap"
    >
      {formatRelative(date)}
    </time>
  );
}

function CopyButton({
  value,
  className,
}: {
  value: unknown;
  className?: string;
}): JSX.Element {
  const [copied, copyText] = useCopyText();
  const json =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        copyText(json);
      }}
      className={cn(
        "rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors",
        className
      )}
      aria-label="Copy value"
    >
      {copied ? (
        <Check className="h-3 w-3 text-emerald-400" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  );
}

export function CollapsibleSection({
  title,
  icon: Icon,
  count,
  defaultOpen = true,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  count: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}): JSX.Element | null {
  const [open, setOpen] = useState(defaultOpen);

  if (count === 0) return null;

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <Icon className="h-3.5 w-3.5" />
        <span>{title}</span>
        <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium">
          {count}
        </span>
      </button>
      {open ? <div className="pb-2">{children}</div> : null}
    </div>
  );
}

// ── Value renderers ─────────────────────────────────────────────

function formatPrimitive(v: unknown): {
  text: string;
  className: string;
} {
  if (v === undefined)
    return { text: "undefined", className: "text-violet-400" };
  if (v === null) return { text: "null", className: "text-violet-400" };
  if (typeof v === "boolean")
    return { text: String(v), className: "text-violet-400" };
  if (typeof v === "number")
    return { text: String(v), className: "text-amber-400" };
  if (typeof v === "string") {
    return { text: `"${v}"`, className: "text-emerald-400" };
  }
  return {
    text: JSON.stringify(v),
    className: "text-muted-foreground",
  };
}

export function KeyValueTable({ value }: { value: unknown }): JSX.Element {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    const fmt = formatPrimitive(value);
    return (
      <span className={cn("text-xs font-mono", fmt.className)}>{fmt.text}</span>
    );
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return (
      <span className="text-xs font-mono text-muted-foreground">{"{}"}</span>
    );
  }

  return (
    <div className="space-y-px">
      {entries.map(([key, val]) => {
        const fmt = formatPrimitive(val);
        return (
          <div
            key={key}
            className="flex gap-2 text-xs font-mono leading-relaxed min-w-0"
          >
            <span className="text-sky-400 shrink-0">{key}</span>
            <span className={cn(fmt.className, "whitespace-nowrap")}>
              {fmt.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Agent ID label ─────────────────────────────────────────────

function AgentIdLabel({ agentId }: { agentId: string }): JSX.Element {
  return (
    <Link
      to={`/activity/history/${agentId}`}
      className="font-mono text-[10px] text-muted-foreground hover:text-foreground transition-colors"
      title={agentId}
      onClick={(e) => e.stopPropagation()}
    >
      <History className="inline h-3 w-3 sm:hidden" />
      <span className="hidden sm:inline">{agentId.slice(0, 12)}</span>
    </Link>
  );
}

// ── Kind styles ────────────────────────────────────────────────

const KIND_STYLES: Record<
  string,
  { dot: string; text: string; badge: string }
> = {
  decision: {
    dot: "bg-rose-400",
    text: "text-rose-400",
    badge: "bg-rose-950/50 text-rose-400",
  },
  assessment: {
    dot: "bg-amber-400",
    text: "text-amber-400",
    badge: "bg-amber-950/50 text-amber-400",
  },
  observation: {
    dot: "bg-blue-400",
    text: "text-blue-400",
    badge: "bg-blue-950/50 text-blue-400",
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

// ── Object card ─────────────────────────────────────────────────

export function ObjectCard({
  obj,
  agentId,
  revision,
  onDelete,
}: {
  obj: BrainObject;
  agentId?: string;
  revision?: number;
  onDelete?: () => void;
}): JSX.Element {
  return (
    <div className="mx-3 mb-2 rounded-md border border-border bg-muted/20 p-2.5 overflow-hidden">
      <div className="flex items-center justify-between gap-2 mb-2 min-w-0">
        <div className="flex items-center gap-1.5 text-xs min-w-0">
          <span className="rounded bg-sky-950/50 px-1.5 py-0.5 font-mono text-sky-400 text-[10px] shrink-0">
            {obj.collection}
          </span>
          <span className="font-medium truncate">{obj.name}</span>
          {revision !== undefined ? (
            <span className="text-[10px] text-muted-foreground shrink-0">
              rev {revision}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground shrink-0">
          {agentId ? <AgentIdLabel agentId={agentId} /> : null}
          <CopyButton value={obj.value} />
          {onDelete ? (
            <DeleteButton
              label={`Delete object ${obj.name}`}
              onClick={onDelete}
            />
          ) : null}
          <RelativeTime iso={obj.updatedAt} />
        </div>
      </div>
      <div className="rounded bg-muted/30 px-2.5 py-2 overflow-x-auto">
        <KeyValueTable
          value={{
            ...(typeof obj.value === "object" &&
            obj.value !== null &&
            !Array.isArray(obj.value)
              ? (obj.value as Record<string, unknown>)
              : { value: obj.value }),
            updatedAt: obj.updatedAt,
          }}
        />
      </div>
    </div>
  );
}

// ── List card with inline items ─────────────────────────────────

function ListItemRow({
  value,
  index,
  createdAt,
}: {
  value: unknown;
  index: number;
  createdAt: string;
}): JSX.Element {
  const isObject =
    value !== null && typeof value === "object" && !Array.isArray(value);
  const entries = isObject
    ? [
        ...Object.entries(value as Record<string, unknown>),
        ["createdAt", createdAt],
      ]
    : [
        ["value", value],
        ["createdAt", createdAt],
      ];

  return (
    <div className="flex gap-2 px-2.5 py-1.5 text-xs font-mono border-b border-border/50 last:border-b-0 min-w-0">
      <span className="text-muted-foreground shrink-0 w-4 text-right pt-px">
        {index}
      </span>
      <div className="flex-1 min-w-0 overflow-x-auto">
        {entries.map(([k, v]) => {
          const fmt = formatPrimitive(v);
          return (
            <div
              key={k as string}
              className="flex gap-1.5 leading-relaxed min-w-0"
            >
              <span className="text-sky-400 shrink-0">{k as string}:</span>
              <span className={cn(fmt.className, "whitespace-nowrap")}>
                {fmt.text}
              </span>
            </div>
          );
        })}
      </div>
      <CopyButton value={value} className="shrink-0 mt-px" />
    </div>
  );
}

export function ListCard({
  list,
  repoRoot,
  agentId,
}: {
  list: BrainList;
  repoRoot: string;
  agentId?: string;
}): JSX.Element {
  const [expanded, setExpanded] = useState(list.itemCount <= 5);
  const { data } = useBrainListItems(repoRoot, list.collection, list.name, {
    limit: expanded ? 50 : 5,
    order: "asc",
  });

  const items = data?.items ?? [];
  const allItemValues = items.map((item) => item.value);

  return (
    <div className="mx-3 mb-2 rounded-md border border-border bg-muted/20 p-2.5 overflow-hidden">
      <div className="flex items-center justify-between gap-2 mb-2 min-w-0">
        <div className="flex items-center gap-1.5 text-xs min-w-0">
          <span className="rounded bg-violet-950/50 px-1.5 py-0.5 font-mono text-violet-400 text-[10px] shrink-0">
            {list.collection}
          </span>
          <span className="font-medium truncate">{list.name}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground shrink-0">
          {agentId ? <AgentIdLabel agentId={agentId} /> : null}
          {items.length > 0 ? <CopyButton value={allItemValues} /> : null}
          <span>{list.itemCount} items</span>
          <RelativeTime iso={list.updatedAt} />
        </div>
      </div>
      {items.length > 0 ? (
        <div className="rounded bg-muted/30 overflow-hidden">
          {items.map((item) => (
            <ListItemRow
              key={item.index}
              value={item.value}
              index={item.index}
              createdAt={item.createdAt}
            />
          ))}
          {!expanded && list.itemCount > 5 ? (
            <button
              onClick={() => setExpanded(true)}
              className="w-full px-2.5 py-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors text-center"
            >
              {list.itemCount <= 50
                ? `Show all ${list.itemCount} items`
                : `Show first 50 of ${list.itemCount} items`}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── Event card ──────────────────────────────────────────────────

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
    <div className="mx-3 mb-2 rounded-md border border-border bg-muted/20 p-2.5 overflow-hidden">
      <div className="flex items-center justify-between gap-2 mb-2 min-w-0">
        <div className="flex items-center gap-1.5 text-xs min-w-0">
          <span className={cn("h-2 w-2 rounded-full shrink-0", style.dot)} />
          <span
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[10px] shrink-0",
              style.badge
            )}
          >
            {event.kind}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground shrink-0">
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
      <div className="rounded bg-muted/30 px-2.5 py-2 overflow-x-auto">
        <KeyValueTable value={allEntries} />
      </div>
    </div>
  );
}

function DeleteButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive"
      aria-label={label}
    >
      <Trash2 className="h-3 w-3" />
    </button>
  );
}
