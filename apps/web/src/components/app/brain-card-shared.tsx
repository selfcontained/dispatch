import { Link } from "react-router-dom";
import { Check, Copy, History, Trash2 } from "lucide-react";

import { useCopyText } from "@/hooks/use-copy";
import { useAgentName } from "@/hooks/use-agent-tree";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { IconButton } from "@/components/ui/icon-button";
import { Hint } from "@/components/ui/tooltip";

// ── Shared primitives ──────────────────────────────────────────

export function RelativeTime({ iso }: { iso: string }): JSX.Element {
  return (
    <Hint label={formatDateTime(iso)}>
      <time dateTime={iso} className="text-muted-foreground whitespace-nowrap">
        {formatRelativeTime(iso)}
      </time>
    </Hint>
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
    <IconButton
      size="icon-xs"
      label="Copy value"
      tooltip={copied ? "Copied" : "Copy value"}
      onClick={(e) => {
        e.stopPropagation();
        copyText(json);
      }}
      className={className}
    >
      {copied ? <Check className="text-success" /> : <Copy />}
    </IconButton>
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
    <IconButton
      size="icon-sm"
      label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="hover:bg-danger/tint hover:text-danger"
    >
      <Trash2 />
    </IconButton>
  );
}

// ── Agent ID label ─────────────────────────────────────────────

export function AgentIdLabel({ agentId }: { agentId: string }): JSX.Element {
  const name = useAgentName(agentId);
  return (
    <Hint label={agentId}>
      <Link
        to={`/activity/history/${agentId}`}
        className="font-mono text-label-xs text-muted-foreground hover:text-foreground transition-colors"
        aria-label={`Open ${name} history`}
        onClick={(e) => e.stopPropagation()}
      >
        <History className="inline h-3 w-3 sm:hidden" />
        <span className="hidden max-w-40 truncate align-bottom sm:inline-block">
          {name}
        </span>
      </Link>
    </Hint>
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
