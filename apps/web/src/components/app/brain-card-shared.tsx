import { Link } from "react-router-dom";
import { Check, Copy, History, Trash2 } from "lucide-react";

import { useCopyText } from "@/hooks/use-copy";
import { cn } from "@/lib/utils";

// ── Shared primitives ──────────────────────────────────────────

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

export function DeleteButton({
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
      className="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
      aria-label={label}
      title={label}
    >
      <Trash2 className="h-3 w-3" />
    </button>
  );
}

// ── Agent ID label ─────────────────────────────────────────────

export function AgentIdLabel({ agentId }: { agentId: string }): JSX.Element {
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

// ── Primitive value formatting ──────────────────────────────────

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
  return {
    text: JSON.stringify(v),
    className: "text-muted-foreground",
  };
}
