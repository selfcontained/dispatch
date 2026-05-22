import { useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  List,
  Radio,
} from "lucide-react";

import {
  useAgentBrainActivity,
  useBrainListItems,
  type BrainObject,
  type BrainList,
  type BrainEvent,
} from "@/hooks/use-brain";
import { useCopyText } from "@/hooks/use-copy";
import { encodeRepoRoot, decodeRepoRoot } from "@/lib/brain-encoding";
import { cn } from "@/lib/utils";

export { encodeRepoRoot, decodeRepoRoot };

type BrainTabContentProps = {
  agentId: string | null;
  repoRoot: string | null;
};

export function formatRelative(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${diffDay}d ago`;
}

export function RelativeTime({ iso }: { iso: string }): JSX.Element {
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

export function CopyButton({
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

export function formatPrimitive(v: unknown): {
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
  if (Array.isArray(v)) {
    const inner = v
      .slice(0, 3)
      .map((item) =>
        typeof item === "string"
          ? `"${item.length > 30 ? item.slice(0, 27) + "…" : item}"`
          : JSON.stringify(item)
      );
    const suffix = v.length > 3 ? `, …+${v.length - 3}` : "";
    return {
      text: `[${inner.join(", ")}${suffix}]`,
      className: "text-muted-foreground",
    };
  }
  const keys = Object.keys(v as Record<string, unknown>);
  return {
    text: `{${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""}}`,
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
            className="flex gap-2 text-xs font-mono leading-relaxed whitespace-nowrap"
          >
            <span className="text-sky-400">{key}</span>
            <span className={fmt.className}>{fmt.text}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Object card ─────────────────────────────────────────────────

function ObjectCard({ obj }: { obj: BrainObject }): JSX.Element {
  return (
    <div className="mx-3 mb-2 rounded-md border border-border bg-muted/20 p-2.5">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 text-xs min-w-0">
          <span className="rounded bg-sky-950/50 px-1.5 py-0.5 font-mono text-sky-400 text-[10px] shrink-0">
            {obj.collection}
          </span>
          <span className="font-medium truncate">{obj.name}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground shrink-0">
          <CopyButton value={obj.value} />
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
      <div className="flex-1 overflow-x-auto">
        <div className="whitespace-nowrap">
          {entries.map(([k, v]) => {
            const fmt = formatPrimitive(v);
            return (
              <div key={k as string} className="flex gap-1.5 leading-relaxed">
                <span className="text-sky-400">{k as string}:</span>
                <span className={fmt.className}>{fmt.text}</span>
              </div>
            );
          })}
        </div>
      </div>
      <CopyButton value={value} className="shrink-0 mt-px" />
    </div>
  );
}

function ListCard({
  list,
  repoRoot,
}: {
  list: BrainList;
  repoRoot: string;
}): JSX.Element {
  const [expanded, setExpanded] = useState(list.itemCount <= 5);
  const { data } = useBrainListItems(repoRoot, list.collection, list.name, {
    limit: expanded ? 50 : 5,
    order: "asc",
  });

  const items = data?.items ?? [];
  const allItemValues = items.map((item) => item.value);

  return (
    <div className="mx-3 mb-2 rounded-md border border-border bg-muted/20 p-2.5">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 text-xs min-w-0">
          <span className="rounded bg-violet-950/50 px-1.5 py-0.5 font-mono text-violet-400 text-[10px] shrink-0">
            {list.collection}
          </span>
          <span className="font-medium truncate">{list.name}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground shrink-0">
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

export const KIND_STYLES: Record<
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

export function getKindStyle(kind: string) {
  return (
    KIND_STYLES[kind] ?? {
      dot: "bg-muted-foreground",
      text: "text-muted-foreground",
      badge: "bg-muted text-muted-foreground",
    }
  );
}

function EventCard({ event }: { event: BrainEvent }): JSX.Element {
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
    <div className="mx-3 mb-2 rounded-md border border-border bg-muted/20 p-2.5">
      <div className="flex items-center justify-between gap-2 mb-2">
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
          <CopyButton value={event.value} />
          <RelativeTime iso={event.createdAt} />
        </div>
      </div>
      <div className="rounded bg-muted/30 px-2.5 py-2 overflow-x-auto">
        <KeyValueTable value={allEntries} />
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────

export function BrainTabContent({
  agentId,
  repoRoot,
}: BrainTabContentProps): JSX.Element {
  const { data, isLoading, isError } = useAgentBrainActivity(agentId, repoRoot);

  if (!agentId || !repoRoot) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-sm text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          <Brain className="h-8 w-8 text-muted-foreground" />
          <div className="mt-4">No brain context available for this agent.</div>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="grid h-full place-items-center p-4">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-sm text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          <Brain className="h-8 w-8 text-muted-foreground" />
          <div className="mt-4">Failed to load brain data.</div>
        </div>
      </div>
    );
  }

  const objects = data?.objects ?? [];
  const lists = data?.lists ?? [];
  const events = data?.events ?? [];

  if (objects.length === 0 && lists.length === 0 && events.length === 0) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-sm text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          <Brain className="h-8 w-8 text-muted-foreground" />
          <div className="mt-4">
            This agent hasn't written any brain data yet.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col overflow-y-auto")}>
      <div className="px-3 py-3 border-b border-border flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Shared memory this agent has written.
        </p>
        {repoRoot ? (
          <Link
            to={`/automations/brains/${encodeRepoRoot(repoRoot)}`}
            className="flex items-center gap-1 text-[11px] text-primary/70 hover:text-primary transition-colors shrink-0"
          >
            View full brain
            <ArrowRight className="h-3 w-3" />
          </Link>
        ) : null}
      </div>
      <CollapsibleSection
        title="Objects"
        icon={Database}
        count={objects.length}
      >
        {objects.map((obj) => (
          <ObjectCard key={`${obj.collection}/${obj.name}`} obj={obj} />
        ))}
      </CollapsibleSection>

      <CollapsibleSection title="Lists" icon={List} count={lists.length}>
        {lists.map((list) => (
          <ListCard
            key={`${list.collection}/${list.name}`}
            list={list}
            repoRoot={repoRoot!}
          />
        ))}
      </CollapsibleSection>

      <CollapsibleSection title="Events" icon={Radio} count={events.length}>
        {events.map((event) => (
          <EventCard key={event.id} event={event} />
        ))}
      </CollapsibleSection>
    </div>
  );
}
