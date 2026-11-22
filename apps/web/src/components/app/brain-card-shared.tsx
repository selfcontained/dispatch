import { Link } from "react-router-dom";
import { Check, Copy, History, Trash2 } from "lucide-react";

import { useCopyText } from "@/hooks/use-copy";
import { useAgentName } from "@/hooks/use-agent-tree";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

// ── Shared primitives ──────────────────────────────────────────

export function RelativeTime({ iso }: { iso: string }): JSX.Element {
  return (
    <time
      dateTime={iso}
      title={formatDateTime(iso)}
      className="text-muted-foreground whitespace-nowrap"
    >
      {formatRelativeTime(iso)}
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
        "rounded-sm p-0.5 text-muted-foreground hover:text-foreground transition-colors",
        className
      )}
      aria-label="Copy value"
    >
      {copied ? (
        <Check className="h-3 w-3 text-success" />
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
      className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-danger/tint hover:text-danger"
      aria-label={label}
      title={label}
    >
      <Trash2 className="h-3 w-3" />
    </button>
  );
}

// ── Agent ID label ─────────────────────────────────────────────

export function AgentIdLabel({ agentId }: { agentId: string }): JSX.Element {
  const name = useAgentName(agentId);
  return (
    <Link
      to={`/activity/history/${agentId}`}
      className="font-mono text-label-xs text-muted-foreground hover:text-foreground transition-colors"
      title={agentId}
      aria-label={`Open ${name} history`}
      onClick={(e) => e.stopPropagation()}
    >
      <History className="inline h-3 w-3 sm:hidden" />
      <span className="hidden max-w-40 truncate align-bottom sm:inline-block">
        {name}
      </span>
    </Link>
  );
}

// ── Primitive value formatting ──────────────────────────────────

export function formatPrimitive(v: unknown): {
  text: string;
  className: string;
} {
  if (v === undefined) return { text: "undefined", className: "text-chart-4" };
  if (v === null) return { text: "null", className: "text-chart-4" };
  if (typeof v === "boolean")
    return { text: String(v), className: "text-chart-4" };
  if (typeof v === "number")
    return { text: String(v), className: "text-chart-2" };
  if (typeof v === "string") {
    return { text: `"${v}"`, className: "text-chart-1" };
  }
  return {
    text: JSON.stringify(v),
    className: "text-muted-foreground",
  };
}
